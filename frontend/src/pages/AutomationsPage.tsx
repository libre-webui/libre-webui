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
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  CircleSlash,
  Loader2,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  Plus,
  Rocket,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import { AutomationModal } from '@/components/automations/AutomationModal';
import { RunHistoryStrip } from '@/components/automations/RunHistoryStrip';
import { automationsApi } from '@/utils/api';
import type {
  AutomationPayload,
  AutomationRunsSummary,
} from '@/utils/api/automationsApi';
import { useChatStore } from '@/store/chatStore';
import { cn, formatTimestamp } from '@/utils';
import { createLogger } from '@/utils/logger';
import { describeTriggers } from '@/utils/automationSchedule';
import {
  AUTOMATION_TEMPLATES,
  type AutomationTemplate,
} from '@/utils/automationTemplates';
import type { Automation, AutomationRun } from '@/types';

const logger = createLogger('pages:automations');

type AutomationsTab = 'automations' | 'runs';

const AutomationsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const models = useChatStore(state => state.models);
  const loadModels = useChatStore(state => state.loadModels);
  const [tab, setTab] = useState<AutomationsTab>('automations');
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [summary, setSummary] = useState<AutomationRunsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [templatePrefill, setTemplatePrefill] =
    useState<Partial<AutomationPayload> | null>(null);
  const [saving, setSaving] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const refresh = useCallback(
    () => setRefreshCounter(counter => counter + 1),
    []
  );

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      automationsApi.getAutomations(),
      automationsApi.getRuns(),
      automationsApi.getRunsSummary(),
    ])
      .then(([listResponse, runsResponse, summaryResponse]) => {
        if (cancelled) return;
        if (listResponse.success && listResponse.data) {
          setAutomations(listResponse.data);
        }
        if (runsResponse.success && runsResponse.data) {
          setRuns(runsResponse.data);
        }
        if (summaryResponse.success && summaryResponse.data) {
          setSummary(summaryResponse.data);
        }
      })
      .catch(error => {
        if (cancelled) return;
        logger.error('Failed to load automations:', error);
        toast.error(t('automations.loadFailed'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshCounter, t]);

  useEffect(() => {
    if (models.length === 0) void loadModels({ quiet: true });
  }, [models.length, loadModels]);

  // Opening the Runs tab acknowledges finished runs.
  useEffect(() => {
    if (tab !== 'runs') return;
    automationsApi
      .markRunsSeen()
      .then(() => automationsApi.getRunsSummary())
      .then(response => {
        if (response.success && response.data) setSummary(response.data);
      })
      .catch(() => undefined);
  }, [tab, runs.length]);

  const openCreate = () => {
    setEditing(null);
    setTemplatePrefill(null);
    setModalOpen(true);
  };

  const openTemplate = (template: AutomationTemplate) => {
    setEditing(null);
    setTemplatePrefill({
      name: t(`automations.templates.${template.id}.name`),
      instructions: template.instructions,
      triggers: template.triggers,
    });
    setModalOpen(true);
  };

  const openEdit = (automation: Automation) => {
    setEditing(automation);
    setTemplatePrefill(null);
    setMenuFor(null);
    setModalOpen(true);
  };

  const handleSave = async (payload: AutomationPayload) => {
    setSaving(true);
    try {
      const response = editing
        ? await automationsApi.updateAutomation(editing.id, payload)
        : await automationsApi.createAutomation(payload);
      if (response.success) {
        setModalOpen(false);
        refresh();
      } else {
        toast.error(response.error || t('automations.saveFailed'));
      }
    } catch (error) {
      logger.error('Failed to save automation:', error);
      toast.error(t('automations.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (
    automation: Automation,
    action: 'pause' | 'resume' | 'run' | 'delete'
  ) => {
    setMenuFor(null);
    try {
      if (action === 'pause') {
        await automationsApi.pauseAutomation(automation.id);
      } else if (action === 'resume') {
        await automationsApi.resumeAutomation(automation.id);
      } else if (action === 'run') {
        await automationsApi.runAutomationNow(automation.id);
        toast.success(t('automations.runQueued'));
      } else {
        await automationsApi.deleteAutomation(automation.id);
      }
      refresh();
    } catch (error) {
      logger.error(`Automation ${action} failed:`, error);
      toast.error(t('automations.actionFailed'));
    }
  };

  const runStatusIcon = (run: AutomationRun) => {
    if (run.status === 'succeeded') {
      return <CheckCircle2 className='h-4 w-4 text-emerald-500' />;
    }
    if (run.status === 'failed') {
      return <XCircle className='h-4 w-4 text-red-500' />;
    }
    return <Loader2 className='h-4 w-4 animate-spin text-gray-400' />;
  };

  const automationName = (automationId: string) =>
    automations.find(item => item.id === automationId)?.name ??
    t('automations.deletedAutomation');

  return (
    <div
      className='flex h-full min-h-0 flex-col overflow-hidden'
      data-testid='automations-page'
    >
      <div className='flex flex-wrap items-center justify-between gap-2 border-b border-black/[0.06] px-4 py-3 dark:border-white/[0.07]'>
        <div className='flex items-center gap-3'>
          <h1 className='text-sm font-semibold text-gray-900 dark:text-dark-900'>
            {t('automations.title')}
          </h1>
          <div className='flex items-center rounded-xl bg-black/[0.04] p-0.5 dark:bg-white/[0.06]'>
            {(['automations', 'runs'] as const).map(choice => (
              <button
                key={choice}
                onClick={() => setTab(choice)}
                data-testid={`automations-tab-${choice}`}
                className={cn(
                  'rounded-[10px] px-2.5 py-1 text-[12px] font-medium transition-colors',
                  tab === choice
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-200 dark:text-dark-900'
                    : 'text-gray-500 hover:text-gray-800 dark:text-dark-500 dark:hover:text-dark-800'
                )}
              >
                {t(`automations.tab.${choice}`)}
              </button>
            ))}
          </div>
        </div>
        <Button
          size='sm'
          onClick={openCreate}
          data-testid='automation-new'
          className='h-7 gap-1 px-2.5 text-[12px]'
        >
          <Plus className='h-3.5 w-3.5' />
          {t('automations.newAutomation')}
        </Button>
      </div>

      <div className='scroll-region min-h-0 flex-1 overflow-y-auto px-4 py-4 scrollbar-thin'>
        {tab === 'automations' ? (
          loading ? null : automations.length === 0 ? (
            <div className='px-3 py-16 text-center'>
              <Zap className='mx-auto mb-2 h-6 w-6 text-gray-300 dark:text-dark-400' />
              <p className='text-sm text-gray-400 dark:text-dark-500'>
                {t('automations.empty')}
              </p>
            </div>
          ) : (
            <div className='mx-auto w-full max-w-3xl space-y-2'>
              {automations.map(automation => (
                <div
                  key={automation.id}
                  data-testid='automation-row'
                  className='rounded-2xl border border-black/[0.06] bg-white/60 px-4 py-3 dark:border-white/[0.07] dark:bg-dark-100/60'
                >
                  <div className='flex items-center justify-between gap-3'>
                    <div className='min-w-0'>
                      <div className='flex items-center gap-2'>
                        <p className='truncate text-[14px] font-medium text-gray-900 dark:text-dark-900'>
                          {automation.name}
                        </p>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
                            automation.status === 'active'
                              ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                              : 'bg-gray-500/10 text-gray-500 dark:text-dark-500'
                          )}
                        >
                          {t(`automations.status.${automation.status}`)}
                        </span>
                      </div>
                      <p className='mt-0.5 truncate text-[12px] text-gray-500 dark:text-dark-500'>
                        {describeTriggers(
                          automation.triggers,
                          i18n.language,
                          t
                        )}
                        {automation.nextRunAt && (
                          <>
                            {' · '}
                            {t('automations.nextRun', {
                              // Absolute, because relative formatting reads
                              // future times as "just now".
                              when: new Intl.DateTimeFormat(i18n.language, {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              }).format(automation.nextRunAt),
                            })}
                          </>
                        )}
                      </p>
                    </div>
                    <div className='relative shrink-0'>
                      <button
                        onClick={() =>
                          setMenuFor(current =>
                            current === automation.id ? null : automation.id
                          )
                        }
                        aria-label={t('automations.actions')}
                        data-testid='automation-menu'
                        className='rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-black/[0.04] hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-dark-800'
                      >
                        <MoreHorizontal className='h-4 w-4' />
                      </button>
                      {menuFor === automation.id && (
                        <div className='absolute end-0 top-8 z-20 w-44 rounded-xl border border-black/[0.07] bg-white p-1 shadow-lg dark:border-white/[0.08] dark:bg-dark-100'>
                          <MenuItem
                            icon={Pencil}
                            label={t('common.edit')}
                            onClick={() => openEdit(automation)}
                          />
                          {automation.status === 'active' ? (
                            <MenuItem
                              icon={Pause}
                              label={t('automations.pause')}
                              onClick={() => runAction(automation, 'pause')}
                            />
                          ) : (
                            <MenuItem
                              icon={Play}
                              label={t('automations.resume')}
                              onClick={() => runAction(automation, 'resume')}
                            />
                          )}
                          <MenuItem
                            icon={Rocket}
                            label={t('automations.runNow')}
                            onClick={() => runAction(automation, 'run')}
                          />
                          <MenuItem
                            icon={Trash2}
                            label={t('common.delete')}
                            destructive
                            onClick={() => runAction(automation, 'delete')}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        ) : null}
        {tab === 'automations' && !loading && (
          <div className='mx-auto mt-8 w-full max-w-3xl'>
            <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500'>
              {t('automations.templatesTitle')}
            </p>
            <div className='grid gap-2 sm:grid-cols-2'>
              {AUTOMATION_TEMPLATES.map(template => (
                <button
                  key={template.id}
                  type='button'
                  onClick={() => openTemplate(template)}
                  data-testid='automation-template'
                  className='rounded-2xl border border-black/[0.06] bg-white/40 px-4 py-3 text-start transition-colors hover:bg-white/80 dark:border-white/[0.07] dark:bg-dark-100/40 dark:hover:bg-dark-100/80'
                >
                  <p className='text-[13px] font-medium text-gray-900 dark:text-dark-900'>
                    {t(`automations.templates.${template.id}.name`)}
                  </p>
                  <p className='mt-0.5 text-[12px] text-gray-500 dark:text-dark-500'>
                    {t(`automations.templates.${template.id}.description`)}
                  </p>
                  <p className='mt-1.5 text-[11px] text-gray-400 dark:text-dark-500'>
                    {describeTriggers(template.triggers, i18n.language, t)}
                  </p>
                </button>
              ))}
            </div>
          </div>
        )}
        {tab === 'runs' && (
          <div className='mx-auto w-full max-w-3xl space-y-4'>
            {summary && (
              <RunHistoryStrip days={summary.days} locale={i18n.language} />
            )}
            {runs.length === 0 ? (
              <div className='px-3 py-12 text-center'>
                <CircleSlash className='mx-auto mb-2 h-6 w-6 text-gray-300 dark:text-dark-400' />
                <p className='text-sm text-gray-400 dark:text-dark-500'>
                  {t('automations.noRuns')}
                </p>
              </div>
            ) : (
              <div className='space-y-1' data-testid='automation-run-list'>
                {runs.map(run => (
                  <div
                    key={run.id}
                    className='flex items-center gap-3 rounded-xl border border-black/[0.05] bg-white/50 px-3 py-2 dark:border-white/[0.06] dark:bg-dark-100/50'
                  >
                    {runStatusIcon(run)}
                    <div className='min-w-0 flex-1'>
                      <p className='truncate text-[13px] text-gray-900 dark:text-dark-900'>
                        {automationName(run.automationId)}
                      </p>
                      <p className='truncate text-[11px] text-gray-400 dark:text-dark-500'>
                        {formatTimestamp(run.scheduledFor, i18n.language)}
                        {run.error && (
                          <>
                            {' · '}
                            <span className='text-red-500'>{run.error}</span>
                          </>
                        )}
                      </p>
                    </div>
                    {run.sessionId && (
                      <button
                        onClick={() => navigate(`/c/${run.sessionId}`)}
                        data-testid='automation-run-open'
                        className='shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-medium text-primary-600 transition-colors hover:bg-primary-500/10 dark:text-primary-400'
                      >
                        {t('automations.openChat')}
                      </button>
                    )}
                    {run.workTaskId && (
                      <button
                        onClick={() => navigate(`/work/${run.workTaskId}`)}
                        data-testid='automation-run-open-task'
                        className='shrink-0 rounded-lg px-2.5 py-1 text-[12px] font-medium text-primary-600 transition-colors hover:bg-primary-500/10 dark:text-primary-400'
                      >
                        {t('automations.openTask')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <AutomationModal
        open={modalOpen}
        automation={editing}
        initial={templatePrefill}
        models={models}
        saving={saving}
        onClose={() => setModalOpen(false)}
        onSave={payload => void handleSave(payload)}
      />
    </div>
  );
};

interface MenuItemProps {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  destructive?: boolean;
  onClick: () => void;
}

function MenuItem({ icon: Icon, label, destructive, onClick }: MenuItemProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-start text-[13px] transition-colors',
        destructive
          ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
          : 'text-gray-700 hover:bg-black/[0.04] dark:text-dark-700 dark:hover:bg-white/[0.06]'
      )}
    >
      <Icon className='h-3.5 w-3.5' />
      {label}
    </button>
  );
}

export default AutomationsPage;
