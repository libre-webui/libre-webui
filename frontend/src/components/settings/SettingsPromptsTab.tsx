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
  BookText,
  Download,
  History,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Button, IconAction, ModalShell } from '@/components/ui';
import { SettingsTabHeader } from './SettingsTabHeader';
import { PromptModal } from '@/components/prompts/PromptModal';
import { WorkspaceTemplateGrid } from './WorkspaceTemplateGrid';
import { PROMPT_TEMPLATES } from '@/utils/promptTemplates';
import { VersionHistoryModal } from '@/components/versions/VersionHistoryModal';
import { promptsApi } from '@/utils/api';
import type {
  Prompt,
  PromptInput,
  PromptRevision,
} from '@/utils/api/promptsApi';
import { formatTimestamp } from '@/utils';
import { downloadJson, readJsonFile } from '@/utils/fileDownload';
import { createLogger } from '@/utils/logger';

const logger = createLogger('pages:prompts');

export const SettingsPromptsTab: React.FC = () => {
  const { t, i18n } = useTranslation();
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Prompt | null>(null);
  const [templatePrefill, setTemplatePrefill] = useState<PromptInput | null>(
    null
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<Prompt | null>(null);
  const [historyFor, setHistoryFor] = useState<Prompt | null>(null);
  const [versions, setVersions] = useState<PromptRevision[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [rollingBackTo, setRollingBackTo] = useState<number | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const refresh = useCallback(
    () => setRefreshCounter(counter => counter + 1),
    []
  );

  useEffect(() => {
    let cancelled = false;
    promptsApi
      .list()
      .then(response => {
        if (cancelled) return;
        if (response.success && response.data) {
          setPrompts(response.data);
        } else {
          toast.error(response.error || t('promptsPage.loadFailed'));
        }
      })
      .catch(error => {
        if (cancelled) return;
        logger.error('Failed to load prompts:', error);
        toast.error(t('promptsPage.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCounter, t]);

  const handleSave = async (payload: PromptInput) => {
    setSaving(true);
    try {
      const response = editing
        ? await promptsApi.update(editing.id, payload)
        : await promptsApi.create(payload);
      if (response.success) {
        setModalOpen(false);
        setTemplatePrefill(null);
        toast.success(t('promptsPage.saved'));
        refresh();
      } else {
        toast.error(response.error || t('promptsPage.saveFailed'));
      }
    } catch (error) {
      logger.error('Failed to save prompt:', error);
      toast.error(t('promptsPage.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    try {
      const response = await promptsApi.remove(target.id);
      if (!response.success) throw new Error(response.error);
      toast.success(t('promptsPage.deleted'));
      refresh();
    } catch (error) {
      logger.error('Failed to delete prompt:', error);
      toast.error(t('promptsPage.deleteFailed'));
    }
  };

  const handleExport = async (prompt: Prompt) => {
    try {
      const response = await promptsApi.export(prompt.id);
      if (!response.success || !response.data) {
        throw new Error(response.error);
      }
      downloadJson(`${prompt.slug}.prompt.json`, response.data);
    } catch (error) {
      logger.error('Failed to export prompt:', error);
      toast.error(t('promptsPage.exportFailed'));
    }
  };

  const handleImport = async (file: File) => {
    try {
      const response = await promptsApi.import(await readJsonFile(file));
      if (!response.success) throw new Error(response.error);
      toast.success(t('promptsPage.imported'));
      refresh();
    } catch (error) {
      logger.error('Failed to import prompt:', error);
      toast.error(t('promptsPage.importFailed'));
    }
  };

  const openHistory = async (prompt: Prompt) => {
    setHistoryFor(prompt);
    setVersionsLoading(true);
    setVersions([]);
    try {
      const response = await promptsApi.versions(prompt.id);
      if (response.success && response.data) {
        setVersions(response.data);
      } else {
        toast.error(response.error || t('promptsPage.historyFailed'));
      }
    } catch (error) {
      logger.error('Failed to load prompt history:', error);
      toast.error(t('promptsPage.historyFailed'));
    } finally {
      setVersionsLoading(false);
    }
  };

  const handleRollback = async (version: number) => {
    if (!historyFor) return;
    setRollingBackTo(version);
    try {
      const response = await promptsApi.rollback(historyFor.id, version);
      if (!response.success || !response.data) {
        throw new Error(response.error);
      }
      toast.success(t('promptsPage.rolledBack'));
      setHistoryFor(null);
      refresh();
    } catch (error) {
      logger.error('Failed to roll the prompt back:', error);
      toast.error(t('promptsPage.rollbackFailed'));
    } finally {
      setRollingBackTo(null);
    }
  };

  return (
    <div data-testid='prompts-page' className='pb-2'>
      <SettingsTabHeader
        title={t('promptsPage.title')}
        description={t('promptsPage.description')}
        actions={
          <>
            <input
              ref={importInputRef}
              type='file'
              accept='application/json,.json'
              className='hidden'
              data-testid='prompt-import-input'
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
              data-testid='prompt-import'
            >
              <Upload className='me-1.5 h-3.5 w-3.5' />
              {t('common.import')}
            </Button>
            <Button
              size='sm'
              onClick={() => {
                setEditing(null);
                setTemplatePrefill(null);
                setModalOpen(true);
              }}
              data-testid='prompt-new'
            >
              <Plus className='me-1.5 h-3.5 w-3.5' />
              {t('promptsPage.newPrompt')}
            </Button>
          </>
        }
      />

      {loading ? null : prompts.length === 0 ? (
        <div className='px-3 py-16 text-center'>
          <BookText className='mx-auto mb-3 h-6 w-6 text-gray-300 dark:text-dark-400' />
          <p className='text-sm text-gray-500 dark:text-dark-500'>
            {t('promptsPage.empty')}
          </p>
          <p className='mx-auto mt-2 max-w-md text-[13px] leading-6 text-gray-400 dark:text-dark-500'>
            {t('promptsPage.emptyHint')}
          </p>
        </div>
      ) : (
        <div className='space-y-2'>
          {prompts.map(prompt => (
            <div
              key={prompt.id}
              data-testid='prompt-row'
              className='rounded-2xl border border-black/[0.06] bg-white/60 px-4 py-3 dark:border-white/[0.07] dark:bg-dark-100/60'
            >
              <div className='flex items-start justify-between gap-3'>
                <div className='min-w-0'>
                  <div className='flex flex-wrap items-center gap-2'>
                    <p className='truncate text-[14px] font-medium text-gray-900 dark:text-dark-900'>
                      {prompt.title}
                    </p>
                    <code className='rounded-md bg-black/[0.04] px-1.5 py-0.5 text-[11px] text-gray-500 dark:bg-white/[0.06] dark:text-dark-500'>
                      /{prompt.slug}
                    </code>
                    <span className='text-[11px] text-gray-400 dark:text-dark-500'>
                      {t('promptsPage.versionLabel', {
                        version: prompt.version,
                      })}
                    </span>
                  </div>
                  {prompt.description && (
                    <p className='mt-1 text-[12px] text-gray-500 dark:text-dark-500'>
                      {prompt.description}
                    </p>
                  )}
                  <div className='mt-1.5 flex flex-wrap items-center gap-1.5'>
                    {prompt.tags.map(tag => (
                      <span
                        key={tag}
                        className='rounded-full bg-black/[0.04] px-2 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-dark-500'
                      >
                        {tag}
                      </span>
                    ))}
                    <span className='text-[11px] text-gray-400 dark:text-dark-500'>
                      {t('promptsPage.updated', {
                        when: formatTimestamp(prompt.updatedAt, i18n.language),
                      })}
                    </span>
                  </div>
                </div>
                <div className='flex shrink-0 items-center gap-1'>
                  <IconAction
                    icon={History}
                    label={t('promptsPage.history.open')}
                    testId='prompt-history'
                    onClick={() => void openHistory(prompt)}
                  />
                  <IconAction
                    icon={Download}
                    label={t('common.export')}
                    testId='prompt-export'
                    onClick={() => void handleExport(prompt)}
                  />
                  <IconAction
                    icon={Pencil}
                    label={t('common.edit')}
                    testId='prompt-edit'
                    onClick={() => {
                      setEditing(prompt);
                      setModalOpen(true);
                    }}
                  />
                  <IconAction
                    icon={Trash2}
                    label={t('common.delete')}
                    testId='prompt-delete'
                    destructive
                    onClick={() => setDeleting(prompt)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && (
        <WorkspaceTemplateGrid
          title={t('promptsPage.templatesTitle')}
          testId='prompt-template'
          cards={PROMPT_TEMPLATES.map(template => ({
            id: template.id,
            name: t(`promptsPage.templates.${template.id}.name`),
            description: t(`promptsPage.templates.${template.id}.description`),
            meta: `/${template.input.slug}`,
          }))}
          onPick={id => {
            const template = PROMPT_TEMPLATES.find(entry => entry.id === id);
            if (!template) return;
            setEditing(null);
            setTemplatePrefill(template.input);
            setModalOpen(true);
          }}
        />
      )}

      <PromptModal
        open={modalOpen}
        prompt={editing}
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
          title={t('promptsPage.history.title', { title: historyFor.title })}
          entries={versions.map(revision => ({
            version: revision.version,
            body: revision.content,
            createdAt: revision.createdAt,
          }))}
          loading={versionsLoading}
          currentVersion={historyFor.version}
          rollingBackTo={rollingBackTo}
          onRollback={version => void handleRollback(version)}
          onClose={() => setHistoryFor(null)}
          testId='prompt-history-modal'
        />
      )}

      {deleting && (
        <ModalShell
          titleId='prompt-delete-title'
          title={t('promptsPage.deleteTitle')}
          subtitle={t('promptsPage.deleteConfirm', { title: deleting.title })}
          onClose={() => setDeleting(null)}
          widthClassName='max-w-sm'
          testId='prompt-delete-modal'
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
                data-testid='prompt-delete-confirm'
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

export default SettingsPromptsTab;
