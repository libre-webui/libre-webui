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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  GraduationCap,
  History,
  Link as LinkIcon,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, IconAction, ModalShell, Switch } from '@/components/ui';
import { SettingsTabHeader } from './SettingsTabHeader';
import { SkillModal } from '@/components/skills/SkillModal';
import { WorkspaceTemplateGrid } from './WorkspaceTemplateGrid';
import { SKILL_TEMPLATES } from '@/utils/skillTemplates';
import { VersionHistoryModal } from '@/components/versions/VersionHistoryModal';
import { skillsApi } from '@/utils/api';
import type { Skill, SkillInput, SkillRevision } from '@/utils/api/skillsApi';
import { formatTimestamp } from '@/utils';
import {
  downloadJson,
  downloadText,
  readJsonFile,
  readTextFile,
} from '@/utils/fileDownload';
import { createLogger } from '@/utils/logger';

const logger = createLogger('pages:skills');

export const SettingsSkillsTab: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [templatePrefill, setTemplatePrefill] = useState<SkillInput | null>(
    null
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Skill | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<Skill | null>(null);
  const [versions, setVersions] = useState<SkillRevision[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [rollingBackTo, setRollingBackTo] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [urlImportOpen, setUrlImportOpen] = useState(false);
  const [urlSource, setUrlSource] = useState('');
  const [urlOverwrite, setUrlOverwrite] = useState(false);
  const [urlImporting, setUrlImporting] = useState(false);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const refresh = useCallback(
    () => setRefreshCounter(counter => counter + 1),
    []
  );

  useEffect(() => {
    let cancelled = false;
    skillsApi
      .list()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setSkills(response.data);
        } else {
          toast.error(response.error || t('skillsPage.loadFailed'));
        }
      })
      .catch(error => {
        if (cancelled) return;
        logger.error('Failed to load skills:', error);
        toast.error(t('skillsPage.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCounter, t]);

  const handleSave = async (payload: SkillInput) => {
    setSaving(true);
    try {
      const response = editing
        ? await skillsApi.update(editing.id, payload)
        : await skillsApi.create(payload);
      if (response.success) {
        setModalOpen(false);
        setTemplatePrefill(null);
        toast.success(t('skillsPage.saved'));
        refresh();
      } else {
        toast.error(response.error || t('skillsPage.saveFailed'));
      }
    } catch (error) {
      logger.error('Failed to save skill:', error);
      toast.error(t('skillsPage.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (skill: Skill, enabled: boolean) => {
    setTogglingId(skill.id);
    // Optimistic: the switch is the whole interaction, so a round trip of
    // dead time reads as a broken control.
    setSkills(current =>
      current.map(item => (item.id === skill.id ? { ...item, enabled } : item))
    );
    try {
      const response = await skillsApi.update(skill.id, { enabled });
      if (!response.success) throw new Error(response.error);
    } catch (error) {
      logger.error('Failed to toggle skill:', error);
      toast.error(t('skillsPage.toggleFailed'));
      setSkills(current =>
        current.map(item =>
          item.id === skill.id ? { ...item, enabled: skill.enabled } : item
        )
      );
    } finally {
      setTogglingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      const response = await skillsApi.remove(target.id);
      if (!response.success) throw new Error(response.error);
      toast.success(t('skillsPage.deleted'));
      refresh();
    } catch (error) {
      logger.error('Failed to delete skill:', error);
      toast.error(t('skillsPage.deleteFailed'));
    }
  };

  const handleExport = async (skill: Skill) => {
    try {
      const response = await skillsApi.export(skill.id);
      if (!response.success || !response.data) {
        throw new Error(response.error);
      }
      if (response.data.markdown) {
        // SKILL.md is the interchange form: frontmatter plus the
        // instructions exactly as written.
        downloadText(`${skill.slug}.skill.md`, response.data.markdown);
      } else {
        downloadJson(`${skill.slug}.skill.json`, response.data);
      }
    } catch (error) {
      logger.error('Failed to export skill:', error);
      toast.error(t('skillsPage.exportFailed'));
    }
  };

  const handleImport = async (file: File) => {
    try {
      const payload = file.name.endsWith('.md')
        ? { markdown: await readTextFile(file) }
        : await readJsonFile(file);
      const response = await skillsApi.import(payload);
      if (!response.success) throw new Error(response.error);
      toast.success(t('skillsPage.imported'));
      refresh();
    } catch (error) {
      logger.error('Failed to import skill:', error);
      toast.error(t('skillsPage.importFailed'));
    }
  };

  const handleUrlImport = async () => {
    if (!urlSource.trim()) return;
    setUrlImporting(true);
    try {
      const response = await skillsApi.importFromUrl(urlSource.trim(), {
        overwriteSlug: urlOverwrite,
      });
      if (!response.success) throw new Error(response.error);
      toast.success(t('skillsPage.imported'));
      setUrlImportOpen(false);
      setUrlSource('');
      setUrlOverwrite(false);
      refresh();
    } catch (error) {
      logger.error('Failed to import the skill from a URL:', error);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('skillsPage.importFailed')
      );
    } finally {
      setUrlImporting(false);
    }
  };

  const openHistory = async (skill: Skill) => {
    setHistoryFor(skill);
    setVersionsLoading(true);
    setVersions([]);
    try {
      const response = await skillsApi.versions(skill.id);
      if (response.success && response.data) {
        setVersions(response.data);
      } else {
        toast.error(response.error || t('skillsPage.historyFailed'));
      }
    } catch (error) {
      logger.error('Failed to load skill history:', error);
      toast.error(t('skillsPage.historyFailed'));
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleRollback = async (version: number) => {
    if (!historyFor) return;
    setRollingBackTo(version);
    try {
      const response = await skillsApi.rollback(historyFor.id, version);
      if (!response.success || !response.data) {
        throw new Error(response.error);
      }
      toast.success(t('skillsPage.rolledBack'));
      setHistoryFor(null);
      refresh();
    } catch (error) {
      logger.error('Failed to roll the skill back:', error);
      toast.error(t('skillsPage.rollbackFailed'));
    } finally {
      setRollingBackTo(null);
    }
  };

  return (
    <div data-testid='skills-page' className='pb-2'>
      <SettingsTabHeader
        title={t('skillsPage.title')}
        description={t('skillsPage.description')}
        actions={
          <>
            <input
              ref={importInputRef}
              type='file'
              accept='application/json,.json,text/markdown,.md'
              className='hidden'
              data-testid='skill-import-input'
              onChange={event => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleImport(file);
              }}
            />
            <Button
              variant='outline'
              size='sm'
              onClick={() => importInputRef.current?.click()}
              data-testid='skill-import'
            >
              <Upload className='me-1.5 h-3.5 w-3.5' />
              {t('common.import')}
            </Button>
            <Button
              variant='outline'
              size='sm'
              onClick={() => setUrlImportOpen(true)}
              data-testid='skill-import-url'
            >
              <LinkIcon className='me-1.5 h-3.5 w-3.5' />
              {t('skillsPage.importUrl.button')}
            </Button>
            <Button
              size='sm'
              onClick={() => {
                setEditing(null);
                setTemplatePrefill(null);
                setModalOpen(true);
              }}
              data-testid='skill-new'
            >
              <Plus className='me-1.5 h-3.5 w-3.5' />
              {t('skillsPage.newSkill')}
            </Button>
          </>
        }
      />

      {loading ? null : skills.length === 0 ? (
        <div className='px-3 py-16 text-center'>
          <GraduationCap className='mx-auto mb-3 h-6 w-6 text-gray-300 dark:text-dark-400' />
          <p className='text-sm text-gray-500 dark:text-dark-500'>
            {t('skillsPage.empty')}
          </p>
          <p className='mx-auto mt-2 max-w-md text-[13px] leading-6 text-gray-400 dark:text-dark-500'>
            {t('skillsPage.emptyHint')}
          </p>
        </div>
      ) : (
        <div className='space-y-2'>
          {skills.map(skill => (
            <div
              key={skill.id}
              data-testid='skill-row'
              className='rounded-2xl border border-black/[0.06] bg-white/60 px-4 py-3 dark:border-white/[0.07] dark:bg-dark-100/60'
            >
              <div className='flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <p className='truncate text-[14px] font-medium text-gray-900 dark:text-dark-900'>
                      {skill.name}
                    </p>
                    <code className='rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/[0.06] dark:text-dark-500'>
                      ${skill.slug}
                    </code>
                    <span className='text-[11px] text-gray-400 dark:text-dark-500'>
                      {t('skillsPage.versionLabel', { version: skill.version })}
                    </span>
                  </div>
                  <p className='mt-1 text-[12px] text-gray-500 dark:text-dark-500'>
                    {skill.description}
                  </p>
                  <p className='mt-1.5 text-[11px] text-gray-400 dark:text-dark-500'>
                    {t('skillsPage.updated', {
                      when: formatTimestamp(skill.updatedAt, i18n.language),
                    })}
                  </p>
                </div>
                <div className='flex shrink-0 items-center gap-1'>
                  <Switch
                    checked={skill.enabled}
                    disabled={togglingId === skill.id}
                    onChange={checked => void handleToggle(skill, checked)}
                  />
                  <IconAction
                    icon={History}
                    label={t('skillsPage.history.open')}
                    testId='skill-history'
                    onClick={() => void openHistory(skill)}
                  />
                  <IconAction
                    icon={Download}
                    label={t('common.export')}
                    testId='skill-export'
                    onClick={() => void handleExport(skill)}
                  />
                  <IconAction
                    icon={Pencil}
                    label={t('common.edit')}
                    testId='skill-edit'
                    onClick={() => {
                      setEditing(skill);
                      setModalOpen(true);
                    }}
                  />
                  <IconAction
                    icon={Trash2}
                    label={t('common.delete')}
                    testId='skill-delete'
                    destructive
                    onClick={() => setDeleting(skill)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && (
        <WorkspaceTemplateGrid
          title={t('skillsPage.templatesTitle')}
          testId='skill-template'
          cards={SKILL_TEMPLATES.map(template => ({
            id: template.id,
            name: t(`skillsPage.templates.${template.id}.name`),
            description: t(`skillsPage.templates.${template.id}.description`),
            meta: `$${template.input.slug}`,
          }))}
          onPick={id => {
            const template = SKILL_TEMPLATES.find(entry => entry.id === id);
            if (!template) return;
            setEditing(null);
            setTemplatePrefill(template.input);
            setModalOpen(true);
          }}
        />
      )}

      {urlImportOpen && (
        <ModalShell
          titleId='skill-import-url-title'
          title={t('skillsPage.importUrl.title')}
          subtitle={t('skillsPage.importUrl.hint')}
          onClose={() => setUrlImportOpen(false)}
          widthClassName='max-w-lg'
          testId='skill-import-url-modal'
          footer={
            <>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setUrlImportOpen(false)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size='sm'
                disabled={urlImporting || !urlSource.trim()}
                onClick={() => void handleUrlImport()}
                data-testid='skill-import-url-submit'
              >
                {urlImporting ? (
                  <Loader2 className='me-1.5 h-3.5 w-3.5 animate-spin' />
                ) : (
                  <Download className='me-1.5 h-3.5 w-3.5' />
                )}
                {t('common.import')}
              </Button>
            </>
          }
        >
          <div className='flex flex-col gap-2'>
            <input
              type='text'
              value={urlSource}
              onChange={event => setUrlSource(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void handleUrlImport();
              }}
              placeholder={t('skillsPage.importUrl.placeholder')}
              dir='ltr'
              autoFocus
              data-testid='skill-import-url-source'
              className='w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-dark-300 dark:bg-dark-100'
            />
            <label className='flex cursor-pointer items-center gap-2 text-xs text-gray-500 dark:text-gray-400'>
              <input
                type='checkbox'
                checked={urlOverwrite}
                onChange={() => setUrlOverwrite(value => !value)}
                className='h-3.5 w-3.5 accent-primary-600'
              />
              {t('skillsPage.importUrl.overwrite')}
            </label>
          </div>
        </ModalShell>
      )}

      <SkillModal
        open={modalOpen}
        skill={editing}
        prefill={templatePrefill}
        saving={saving}
        onClose={() => {
          setModalOpen(false);
          setTemplatePrefill(null);
        }}
        onSave={payload => void handleSave(payload)}
      />

      {historyFor && (
        <VersionHistoryModal
          title={t('skillsPage.history.title', { name: historyFor.name })}
          entries={versions.map(revision => ({
            version: revision.version,
            body: revision.instructions,
            createdAt: revision.createdAt,
          }))}
          loading={versionsLoading}
          currentVersion={historyFor.version}
          rollingBackTo={rollingBackTo}
          onRollback={version => void handleRollback(version)}
          onClose={() => setHistoryFor(null)}
          testId='skill-history-modal'
        />
      )}

      {deleting && (
        <ModalShell
          titleId='skill-delete-title'
          title={t('skillsPage.deleteTitle')}
          subtitle={t('skillsPage.deleteConfirm', { name: deleting.name })}
          onClose={() => setDeleting(null)}
          widthClassName='max-w-sm'
          testId='skill-delete-modal'
          footer={
            <>
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setDeleting(null)}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant='danger'
                size='sm'
                onClick={() => void handleDelete()}
                data-testid='skill-delete-confirm'
              >
                {t('common.delete')}
              </Button>
            </>
          }
        />
      )}
    </div>
  );
};

export default SettingsSkillsTab;
