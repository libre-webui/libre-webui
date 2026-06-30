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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  Activity,
  Bot,
  CalendarClock,
  Check,
  Clock,
  ExternalLink,
  GitBranch,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  libreClawApi,
  LibreClawAutomation,
  LibreClawEvent,
  LibreClawPermissionResolution,
  LibreClawRun,
  LibreClawStatus,
} from '@/utils/api';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';

const logger = createLogger('pages:libre-claw');

const stateStyles: Record<string, string> = {
  queued: 'bg-gray-100 text-gray-700 dark:bg-dark-200 dark:text-dark-700',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  blocked:
    'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  done: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
  cancelled:
    'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
};

const eventTypeStyles: Record<string, string> = {
  assistant_message: 'text-blue-600 dark:text-blue-300',
  assistant_delta: 'text-blue-600 dark:text-blue-300',
  user_message: 'text-gray-700 dark:text-dark-700',
  permission_request: 'text-amber-600 dark:text-amber-300',
  permission_response: 'text-emerald-600 dark:text-emerald-300',
  tool_call: 'text-purple-600 dark:text-purple-300',
  tool_result: 'text-emerald-600 dark:text-emerald-300',
  usage: 'text-cyan-600 dark:text-cyan-300',
  error: 'text-red-600 dark:text-red-300',
  run_finished: 'text-emerald-600 dark:text-emerald-300',
};

type TimelineItemKind = 'assistant_message' | 'event';

interface TimelineItem {
  key: string;
  kind: TimelineItemKind;
  eventType: string;
  label: string;
  firstEventId: number;
  lastEventId: number;
  timestamp: string;
  events: LibreClawEvent[];
}

const themeOptions = [
  ['lobster', 'Lobster'],
  ['lobster-light', 'Lobster Light'],
  ['github-dark', 'GitHub Dark'],
  ['github-light', 'GitHub Light'],
  ['monokai-pro', 'Monokai Pro'],
  ['night-owl', 'Night Owl'],
  ['tokyo-night', 'Tokyo Night'],
  ['ayu', 'Ayu'],
  ['dracula', 'Dracula'],
  ['catppuccin-mocha', 'Catppuccin Mocha'],
  ['catppuccin-latte', 'Catppuccin Latte'],
  ['gruvbox-dark', 'Gruvbox Dark'],
  ['nord', 'Nord'],
  ['solarized-dark', 'Solarized Dark'],
  ['solarized-light', 'Solarized Light'],
  ['one-dark-pro', 'One Dark Pro'],
  ['rose-pine', 'Rose Pine'],
  ['kanagawa', 'Kanagawa'],
  ['matrix', 'Matrix'],
] as const;

const LibreClawPage: React.FC = () => {
  const [status, setStatus] = useState<LibreClawStatus | null>(null);
  const [runs, setRuns] = useState<LibreClawRun[]>([]);
  const [events, setEvents] = useState<LibreClawEvent[]>([]);
  const [automations, setAutomations] = useState<LibreClawAutomation[]>([]);
  const [modelConfig, setModelConfig] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [fallbackConfig, setFallbackConfig] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [usageText, setUsageText] = useState('');
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [startingRun, setStartingRun] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [savingTheme, setSavingTheme] = useState(false);
  const [savingAutomation, setSavingAutomation] = useState(false);

  const [runMessage, setRunMessage] = useState('');
  const [runKind, setRunKind] = useState<'chat' | 'goal'>('chat');
  const [runProvider, setRunProvider] = useState('');
  const [runModel, setRunModel] = useState('');
  const [modelProvider, setModelProvider] = useState('');
  const [modelName, setModelName] = useState('');
  const [persistModel, setPersistModel] = useState(false);
  const [clawTheme, setClawTheme] = useState('lobster');
  const [persistTheme, setPersistTheme] = useState(true);

  const [automationName, setAutomationName] = useState('');
  const [automationSchedule, setAutomationSchedule] = useState('');
  const [automationPrompt, setAutomationPrompt] = useState('');
  const [automationRoute, setAutomationRoute] = useState('report');

  const selectedRun = useMemo(
    () => runs.find(run => run.run_id === selectedRunId) || null,
    [runs, selectedRunId]
  );

  const pendingPermissionEvents = useMemo(() => {
    const resolved = new Set(
      events
        .filter(event => event.type === 'permission_response')
        .map(event => String(event.data.tool_call_id || ''))
    );
    return events.filter(event => {
      if (event.type !== 'permission_request') return false;
      const toolCallId = String(event.data.tool_call_id || '');
      return toolCallId && !resolved.has(toolCallId);
    });
  }, [events]);

  const timelineItems = useMemo(() => buildTimelineItems(events), [events]);

  const loadOverview = useCallback(async () => {
    try {
      const [
        statusRes,
        runsRes,
        modelRes,
        fallbackRes,
        usageRes,
        automationsRes,
      ] = await Promise.all([
        libreClawApi.status(),
        libreClawApi.listRuns(30),
        libreClawApi.currentModel(),
        libreClawApi.currentFallback(),
        libreClawApi.usage('', 100),
        libreClawApi.listAutomations(50),
      ]);

      if (statusRes.success && statusRes.data) {
        setStatus(statusRes.data);
      }
      if (runsRes.success && runsRes.data) {
        setRuns(runsRes.data.runs);
        setSelectedRunId(
          current => current || runsRes.data?.runs[0]?.run_id || null
        );
      }
      if (modelRes.success && modelRes.data) {
        setModelConfig(modelRes.data);
        setModelProvider(String(modelRes.data.provider || ''));
        setModelName(String(modelRes.data.model || ''));
      }
      if (fallbackRes.success && fallbackRes.data) {
        setFallbackConfig(fallbackRes.data);
      }
      if (usageRes.success && usageRes.data) {
        setUsageText(String(usageRes.data.text || ''));
      }
      if (automationsRes.success && automationsRes.data) {
        setAutomations(automationsRes.data.automations);
      }
    } catch (error) {
      logger.error('Failed to load Libre Claw overview:', error);
      toast.error('Could not load Libre Claw status');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadEvents = useCallback(
    async (runId: string, replace = false) => {
      const after = replace
        ? 0
        : events.length > 0
          ? events[events.length - 1]?.event_id || 0
          : 0;
      try {
        const response = await libreClawApi.getEvents(runId, after);
        if (response.success && response.data) {
          setEvents(current =>
            replace
              ? response.data?.events || []
              : [...current, ...(response.data?.events || [])]
          );
        }
      } catch (error) {
        logger.error('Failed to load Libre Claw events:', error);
      }
    },
    [events]
  );

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      loadOverview();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadOverview]);

  useEffect(() => {
    if (!selectedRunId) {
      const timeout = window.setTimeout(() => {
        setEvents([]);
      }, 0);
      return () => window.clearTimeout(timeout);
    }
    const runId = selectedRunId;
    libreClawApi
      .getEvents(runId, 0)
      .then(response => {
        if (response.success && response.data) {
          setEvents(response.data.events);
        }
      })
      .catch(error => {
        logger.error('Failed to load Libre Claw events:', error);
      });
  }, [selectedRunId]);

  useEffect(() => {
    if (!selectedRunId || !selectedRun) return;
    if (!['queued', 'running', 'blocked'].includes(selectedRun.state)) return;

    const interval = window.setInterval(() => {
      loadEvents(selectedRunId);
      libreClawApi.listRuns(30).then(response => {
        if (response.success && response.data) {
          setRuns(response.data.runs);
        }
      });
    }, 1500);

    return () => window.clearInterval(interval);
  }, [loadEvents, selectedRun, selectedRunId]);

  const startRun = async () => {
    if (!runMessage.trim()) {
      toast.error('Enter a task for Libre Claw');
      return;
    }
    setStartingRun(true);
    try {
      const response = await libreClawApi.startRun({
        message: runMessage,
        kind: runKind,
        provider: runProvider || undefined,
        model: runModel || undefined,
      });
      if (response.success && response.data) {
        const run = response.data.run;
        setRuns(current => [
          run,
          ...current.filter(item => item.run_id !== run.run_id),
        ]);
        setSelectedRunId(run.run_id);
        setRunMessage('');
        toast.success('Libre Claw run started');
      } else {
        toast.error(response.error || 'Could not start Libre Claw run');
      }
    } catch (error) {
      logger.error('Failed to start Libre Claw run:', error);
      toast.error('Could not start Libre Claw run');
    } finally {
      setStartingRun(false);
    }
  };

  const cancelRun = async (runId: string) => {
    try {
      await libreClawApi.cancelRun(runId);
      await loadOverview();
      toast.success('Run cancelled');
    } catch (error) {
      logger.error('Failed to cancel Libre Claw run:', error);
      toast.error('Could not cancel run');
    }
  };

  const resolvePermission = async (
    event: LibreClawEvent,
    resolution: LibreClawPermissionResolution
  ) => {
    if (!selectedRunId) return;
    const toolCallId = String(event.data.tool_call_id || '');
    if (!toolCallId) return;

    try {
      await libreClawApi.resolvePermission(
        selectedRunId,
        toolCallId,
        resolution
      );
      await loadEvents(selectedRunId, true);
      toast.success(resolution === 'deny' ? 'Denied' : 'Approved');
    } catch (error) {
      logger.error('Failed to resolve Libre Claw permission:', error);
      toast.error('Could not resolve permission');
    }
  };

  const saveModel = async () => {
    if (!modelProvider.trim() || !modelName.trim()) {
      toast.error('Provider and model are required');
      return;
    }
    setSavingModel(true);
    try {
      const response = await libreClawApi.updateModel(
        modelProvider,
        modelName,
        persistModel
      );
      if (response.success && response.data) {
        setModelConfig(response.data);
        toast.success('Libre Claw model updated');
      } else {
        toast.error(response.error || 'Could not update model');
      }
    } catch (error) {
      logger.error('Failed to update Libre Claw model:', error);
      toast.error('Could not update model');
    } finally {
      setSavingModel(false);
    }
  };

  const saveTheme = async () => {
    setSavingTheme(true);
    try {
      const response = await libreClawApi.updateTheme(clawTheme, persistTheme);
      if (response.success) {
        toast.success('Libre Claw theme updated');
      } else {
        toast.error(response.error || 'Could not update theme');
      }
    } catch (error) {
      logger.error('Failed to update Libre Claw theme:', error);
      toast.error('Could not update theme');
    } finally {
      setSavingTheme(false);
    }
  };

  const createAutomation = async () => {
    if (
      !automationName.trim() ||
      !automationSchedule.trim() ||
      !automationPrompt.trim()
    ) {
      toast.error('Automation name, schedule, and prompt are required');
      return;
    }
    setSavingAutomation(true);
    try {
      const response = await libreClawApi.createAutomation({
        name: automationName,
        schedule: automationSchedule,
        prompt: automationPrompt,
        route: automationRoute,
      });
      if (response.success) {
        setAutomationName('');
        setAutomationSchedule('');
        setAutomationPrompt('');
        await loadOverview();
        toast.success('Automation created');
      } else {
        toast.error(response.error || 'Could not create automation');
      }
    } catch (error) {
      logger.error('Failed to create Libre Claw automation:', error);
      toast.error('Could not create automation');
    } finally {
      setSavingAutomation(false);
    }
  };

  const automationAction = async (
    automationId: string,
    action: 'pause' | 'resume' | 'run' | 'delete'
  ) => {
    try {
      if (action === 'pause') await libreClawApi.pauseAutomation(automationId);
      if (action === 'resume')
        await libreClawApi.resumeAutomation(automationId);
      if (action === 'run') await libreClawApi.runAutomationNow(automationId);
      if (action === 'delete')
        await libreClawApi.deleteAutomation(automationId);
      await loadOverview();
      toast.success('Automation updated');
    } catch (error) {
      logger.error('Failed to update Libre Claw automation:', error);
      toast.error('Could not update automation');
    }
  };

  return (
    <div className='h-full overflow-y-auto bg-gray-50 dark:bg-dark-100'>
      <div className='mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 space-y-6'>
        <header className='flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between'>
          <div>
            <div className='flex items-center gap-3'>
              <div className='flex h-11 w-11 items-center justify-center rounded-xl bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'>
                <Bot className='h-5 w-5' />
              </div>
              <div>
                <h1 className='text-2xl font-semibold text-gray-950 dark:text-gray-100'>
                  Libre Claw
                </h1>
                <p className='text-sm text-gray-600 dark:text-dark-600'>
                  Local agent runs, approvals, schedules, memory, tools, and
                  usage.
                </p>
              </div>
            </div>
          </div>

          <div className='flex flex-wrap items-center gap-2'>
            <StatusPill status={status} />
            <Button variant='secondary' size='sm' onClick={loadOverview}>
              <RefreshCw className='h-4 w-4' />
              Refresh
            </Button>
            <a
              href={status?.dashboardUrl || 'http://127.0.0.1:8766/dashboard'}
              target='_blank'
              rel='noopener noreferrer'
              className='inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 shadow-sm transition-colors hover:bg-gray-50 dark:border-dark-300 dark:bg-dark-50 dark:text-dark-700 dark:hover:bg-dark-100'
            >
              <ExternalLink className='h-4 w-4' />
              Dashboard
            </a>
          </div>
        </header>

        {!status?.connected && !loading && (
          <section className='rounded-xl border border-amber-200 bg-amber-50 p-4 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200'>
            <div className='flex items-start gap-3'>
              <Terminal className='mt-0.5 h-5 w-5 shrink-0' />
              <div>
                <h2 className='font-semibold'>
                  Libre Claw daemon is not connected
                </h2>
                <p className='mt-1 text-sm opacity-90'>
                  Start it locally with <code>libre-claw start</code> or set{' '}
                  <code>LIBRE_CLAW_BASE_URL</code> in the backend environment.
                </p>
                {status?.error && (
                  <p className='mt-2 text-xs opacity-80'>{status.error}</p>
                )}
              </div>
            </div>
          </section>
        )}

        <section className='grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]'>
          <Panel title='Start Agent Run' icon={<Play className='h-4 w-4' />}>
            <div className='space-y-3'>
              <textarea
                value={runMessage}
                onChange={event => setRunMessage(event.target.value)}
                placeholder='Ask Libre Claw to inspect a repo, fix a bug, run a review, schedule a report...'
                className='min-h-32 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-primary-400 focus:ring-2 focus:ring-primary-100 dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800 dark:focus:border-primary-500 dark:focus:ring-primary-900/30'
              />
              <div className='grid gap-3 sm:grid-cols-4'>
                <select
                  value={runKind}
                  onChange={event =>
                    setRunKind(event.target.value as 'chat' | 'goal')
                  }
                  className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                >
                  <option value='chat'>Chat run</option>
                  <option value='goal'>Goal mode</option>
                </select>
                <input
                  value={runProvider}
                  onChange={event => setRunProvider(event.target.value)}
                  placeholder='Provider override'
                  className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                />
                <input
                  value={runModel}
                  onChange={event => setRunModel(event.target.value)}
                  placeholder='Model override'
                  className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                />
                <Button onClick={startRun} loading={startingRun}>
                  <Bot className='h-4 w-4' />
                  Run
                </Button>
              </div>
            </div>
          </Panel>

          <Panel title='Model Route' icon={<GitBranch className='h-4 w-4' />}>
            <div className='space-y-3'>
              <div className='grid gap-2 sm:grid-cols-2 lg:grid-cols-1'>
                <input
                  value={modelProvider}
                  onChange={event => setModelProvider(event.target.value)}
                  placeholder='provider'
                  className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                />
                <input
                  value={modelName}
                  onChange={event => setModelName(event.target.value)}
                  placeholder='model'
                  className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                />
              </div>
              <label className='flex items-center gap-2 text-sm text-gray-600 dark:text-dark-600'>
                <input
                  type='checkbox'
                  checked={persistModel}
                  onChange={event => setPersistModel(event.target.checked)}
                  className='h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500'
                />
                Persist to Libre Claw global config
              </label>
              <Button
                variant='secondary'
                onClick={saveModel}
                loading={savingModel}
              >
                Save model
              </Button>
              <div className='border-t border-gray-100 pt-3 dark:border-dark-200'>
                <label className='mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-dark-500'>
                  Libre Claw theme
                </label>
                <div className='grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-1'>
                  <select
                    value={clawTheme}
                    onChange={event => setClawTheme(event.target.value)}
                    className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                  >
                    {themeOptions.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant='secondary'
                    onClick={saveTheme}
                    loading={savingTheme}
                  >
                    Save theme
                  </Button>
                </div>
                <label className='mt-2 flex items-center gap-2 text-sm text-gray-600 dark:text-dark-600'>
                  <input
                    type='checkbox'
                    checked={persistTheme}
                    onChange={event => setPersistTheme(event.target.checked)}
                    className='h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-primary-500'
                  />
                  Persist to Libre Claw global config
                </label>
              </div>
              {modelConfig && (
                <pre className='max-h-32 overflow-auto rounded-lg bg-gray-100 p-2 text-xs text-gray-700 dark:bg-dark-200 dark:text-dark-700'>
                  {JSON.stringify(modelConfig, null, 2)}
                </pre>
              )}
            </div>
          </Panel>
        </section>

        <section className='grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]'>
          <Panel title='Runs' icon={<Activity className='h-4 w-4' />}>
            <div className='space-y-2'>
              {runs.length === 0 && (
                <EmptyState text='No Libre Claw runs yet.' />
              )}
              {runs.map(run => (
                <button
                  key={run.run_id}
                  onClick={() => setSelectedRunId(run.run_id)}
                  className={cn(
                    'w-full rounded-xl border p-3 text-left transition',
                    selectedRunId === run.run_id
                      ? 'border-primary-300 bg-primary-50 dark:border-primary-700 dark:bg-primary-900/20'
                      : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-dark-300 dark:bg-dark-50 dark:hover:bg-dark-100'
                  )}
                >
                  <div className='flex items-center justify-between gap-2'>
                    <span className='truncate text-sm font-medium text-gray-900 dark:text-dark-900'>
                      {run.title}
                    </span>
                    <StateBadge state={run.state} />
                  </div>
                  <div className='mt-1 truncate text-xs text-gray-500 dark:text-dark-500'>
                    {run.provider}:{run.model}
                  </div>
                  <div className='mt-1 text-xs text-gray-400 dark:text-dark-500'>
                    {formatDate(run.updated_at)}
                  </div>
                </button>
              ))}
            </div>
          </Panel>

          <Panel
            title={selectedRun ? selectedRun.title : 'Run Timeline'}
            icon={<Clock className='h-4 w-4' />}
            actions={
              selectedRun &&
              ['queued', 'running', 'blocked'].includes(selectedRun.state) ? (
                <Button
                  variant='danger'
                  size='sm'
                  onClick={() => cancelRun(selectedRun.run_id)}
                >
                  <Square className='h-4 w-4' />
                  Cancel
                </Button>
              ) : null
            }
          >
            {pendingPermissionEvents.length > 0 && (
              <div className='mb-4 space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20'>
                <div className='flex items-center gap-2 text-sm font-semibold text-amber-800 dark:text-amber-200'>
                  <ShieldCheck className='h-4 w-4' />
                  Approval needed
                </div>
                {pendingPermissionEvents.map(event => (
                  <div
                    key={event.event_id}
                    className='rounded-lg bg-white/70 p-3 dark:bg-dark-50/70'
                  >
                    <div className='text-sm font-medium text-gray-900 dark:text-dark-900'>
                      {String(event.data.name || 'tool')}
                    </div>
                    <pre className='mt-2 max-h-36 overflow-auto rounded bg-gray-100 p-2 text-xs text-gray-700 dark:bg-dark-200 dark:text-dark-700'>
                      {JSON.stringify(event.data.arguments || {}, null, 2)}
                    </pre>
                    <div className='mt-3 flex flex-wrap gap-2'>
                      <Button
                        size='sm'
                        onClick={() => resolvePermission(event, 'allow_once')}
                      >
                        <Check className='h-4 w-4' />
                        Allow once
                      </Button>
                      <Button
                        size='sm'
                        variant='secondary'
                        onClick={() =>
                          resolvePermission(event, 'always_allow_tool')
                        }
                      >
                        Always allow tool
                      </Button>
                      <Button
                        size='sm'
                        variant='danger'
                        onClick={() => resolvePermission(event, 'deny')}
                      >
                        <X className='h-4 w-4' />
                        Deny
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className='space-y-3'>
              {events.length === 0 && (
                <EmptyState text='Select a run to inspect its events.' />
              )}
              {timelineItems.map(item => (
                <TimelineCard key={item.key} item={item} />
              ))}
            </div>
          </Panel>
        </section>

        <section className='grid gap-4 xl:grid-cols-2'>
          <Panel
            title='Automations'
            icon={<CalendarClock className='h-4 w-4' />}
          >
            <div className='space-y-4'>
              <div className='grid gap-2 sm:grid-cols-2'>
                <input
                  value={automationName}
                  onChange={event => setAutomationName(event.target.value)}
                  placeholder='Name'
                  className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                />
                <input
                  value={automationSchedule}
                  onChange={event => setAutomationSchedule(event.target.value)}
                  placeholder='daily 09:00'
                  className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                />
                <select
                  value={automationRoute}
                  onChange={event => setAutomationRoute(event.target.value)}
                  className='rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
                >
                  <option value='report'>Report</option>
                  <option value='telegram'>Telegram</option>
                </select>
                <Button onClick={createAutomation} loading={savingAutomation}>
                  Create
                </Button>
              </div>
              <textarea
                value={automationPrompt}
                onChange={event => setAutomationPrompt(event.target.value)}
                placeholder='Automation prompt'
                className='min-h-24 w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50 dark:text-dark-800'
              />
              <div className='space-y-2'>
                {automations.length === 0 && (
                  <EmptyState text='No scheduled Libre Claw automations.' />
                )}
                {automations.map(automation => (
                  <div
                    key={automation.automation_id}
                    className='rounded-xl border border-gray-200 bg-white p-3 dark:border-dark-300 dark:bg-dark-50'
                  >
                    <div className='flex items-start justify-between gap-3'>
                      <div className='min-w-0'>
                        <div className='truncate text-sm font-medium text-gray-900 dark:text-dark-900'>
                          {automation.name}
                        </div>
                        <div className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
                          {automation.schedule} · {automation.route} ·{' '}
                          {automation.status}
                        </div>
                      </div>
                      <div className='flex shrink-0 gap-1'>
                        <IconButton
                          title='Run now'
                          onClick={() =>
                            automationAction(automation.automation_id, 'run')
                          }
                        >
                          <Play className='h-4 w-4' />
                        </IconButton>
                        <IconButton
                          title={
                            automation.status === 'paused' ? 'Resume' : 'Pause'
                          }
                          onClick={() =>
                            automationAction(
                              automation.automation_id,
                              automation.status === 'paused'
                                ? 'resume'
                                : 'pause'
                            )
                          }
                        >
                          {automation.status === 'paused' ? (
                            <Play className='h-4 w-4' />
                          ) : (
                            <Pause className='h-4 w-4' />
                          )}
                        </IconButton>
                        <IconButton
                          title='Delete'
                          danger
                          onClick={() =>
                            automationAction(automation.automation_id, 'delete')
                          }
                        >
                          <Trash2 className='h-4 w-4' />
                        </IconButton>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </Panel>

          <Panel
            title='Usage And Fallback'
            icon={<Activity className='h-4 w-4' />}
          >
            <div className='space-y-4'>
              <div>
                <h3 className='mb-2 text-sm font-semibold text-gray-900 dark:text-dark-900'>
                  Usage
                </h3>
                <pre className='max-h-52 overflow-auto rounded-xl bg-gray-100 p-3 text-xs text-gray-700 dark:bg-dark-200 dark:text-dark-700'>
                  {usageText || 'No usage records yet.'}
                </pre>
              </div>
              <div>
                <h3 className='mb-2 text-sm font-semibold text-gray-900 dark:text-dark-900'>
                  Fallback Route
                </h3>
                <pre className='max-h-52 overflow-auto rounded-xl bg-gray-100 p-3 text-xs text-gray-700 dark:bg-dark-200 dark:text-dark-700'>
                  {JSON.stringify(fallbackConfig || {}, null, 2)}
                </pre>
              </div>
            </div>
          </Panel>
        </section>
      </div>

      {loading && (
        <div className='fixed inset-0 z-40 flex items-center justify-center bg-white/60 backdrop-blur-sm dark:bg-dark-50/60'>
          <Loader2 className='h-7 w-7 animate-spin text-primary-600' />
        </div>
      )}
    </div>
  );
};

const StatusPill: React.FC<{ status: LibreClawStatus | null }> = ({
  status,
}) => {
  const connected = Boolean(status?.connected);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium',
        connected
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300'
          : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'
      )}
    >
      <span
        className={cn(
          'h-2 w-2 rounded-full',
          connected ? 'bg-emerald-500' : 'bg-amber-500'
        )}
      />
      {connected ? 'Connected' : 'Disconnected'}
      {status?.health?.active_runs !== undefined && (
        <span className='opacity-70'>
          · {String(status.health.active_runs)} active
        </span>
      )}
    </span>
  );
};

const StateBadge: React.FC<{ state: string }> = ({ state }) => (
  <span
    className={cn(
      'rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
      stateStyles[state] || stateStyles.queued
    )}
  >
    {state}
  </span>
);

const Panel: React.FC<{
  title: string;
  icon: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, icon, actions, children }) => (
  <section className='rounded-xl border border-gray-200 bg-white shadow-sm dark:border-dark-300 dark:bg-dark-25'>
    <header className='flex items-center justify-between gap-3 border-b border-gray-100 px-4 py-3 dark:border-dark-200'>
      <div className='flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-dark-900'>
        <span className='text-primary-600 dark:text-primary-300'>{icon}</span>
        {title}
      </div>
      {actions}
    </header>
    <div className='p-4'>{children}</div>
  </section>
);

const IconButton: React.FC<{
  title: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ title, danger, onClick, children }) => (
  <button
    type='button'
    title={title}
    onClick={onClick}
    className={cn(
      'inline-flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
      danger
        ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
        : 'text-gray-500 hover:bg-gray-100 dark:text-dark-500 dark:hover:bg-dark-200'
    )}
  >
    {children}
  </button>
);

const TimelineCard: React.FC<{ item: TimelineItem }> = ({ item }) => (
  <article
    className={cn(
      'rounded-xl border p-3 transition-colors',
      item.eventType === 'assistant_message'
        ? 'border-primary-200 bg-primary-50/60 dark:border-primary-900/60 dark:bg-primary-900/10'
        : item.eventType === 'user_message'
          ? 'border-gray-200 bg-white dark:border-dark-300 dark:bg-dark-50'
          : 'border-gray-200 bg-white dark:border-dark-300 dark:bg-dark-50'
    )}
  >
    <div className='mb-2 flex items-center justify-between gap-3'>
      <span
        className={cn(
          'text-xs font-semibold uppercase tracking-wide',
          eventTypeStyles[item.eventType] || 'text-gray-500 dark:text-dark-500'
        )}
      >
        {item.label}
      </span>
      <span className='shrink-0 text-xs text-gray-400 dark:text-dark-500'>
        {formatEventRange(item)} · {formatDate(item.timestamp)}
      </span>
    </div>
    <TimelineBody item={item} />
  </article>
);

const TimelineBody: React.FC<{ item: TimelineItem }> = ({ item }) => {
  if (item.kind === 'assistant_message') {
    return (
      <p className='whitespace-pre-wrap text-sm leading-6 text-gray-900 dark:text-dark-900'>
        {joinAssistantDeltas(item.events) || 'Streaming...'}
      </p>
    );
  }

  const event = item.events[0];
  if (!event) return null;

  if (event.type === 'assistant_delta') {
    return (
      <p className='whitespace-pre-wrap text-sm text-gray-800 dark:text-dark-800'>
        {String(event.data.text || '')}
      </p>
    );
  }

  if (event.type === 'user_message') {
    return (
      <p className='whitespace-pre-wrap text-sm text-gray-800 dark:text-dark-800'>
        {String(event.data.content || '')}
      </p>
    );
  }

  if (event.type === 'tool_call') {
    return (
      <div>
        <div className='text-sm font-medium text-gray-900 dark:text-dark-900'>
          {String(event.data.name || 'tool')}
        </div>
        <JsonBlock value={event.data.arguments || {}} />
      </div>
    );
  }

  if (event.type === 'tool_result') {
    return (
      <div>
        <div className='text-sm font-medium text-gray-900 dark:text-dark-900'>
          {String(event.data.name || 'tool')} ·{' '}
          {event.data.is_error ? 'error' : 'ok'}
        </div>
        <pre className='mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-lg bg-gray-100 p-2 text-xs text-gray-700 dark:bg-dark-200 dark:text-dark-700'>
          {String(event.data.content || '')}
        </pre>
      </div>
    );
  }

  if (event.type === 'permission_request') {
    return (
      <div>
        <div className='text-sm font-medium text-gray-900 dark:text-dark-900'>
          {String(event.data.name || 'Tool approval requested')}
        </div>
        <JsonBlock value={event.data.arguments || {}} />
      </div>
    );
  }

  if (event.type === 'permission_response') {
    return (
      <div className='flex flex-wrap gap-2'>
        <MetricPill
          label='Tool'
          value={String(event.data.name || event.data.tool_call_id || 'tool')}
        />
        <MetricPill
          label='Resolution'
          value={String(event.data.resolution || 'resolved')}
        />
      </div>
    );
  }

  if (event.type === 'usage') {
    return <UsageSummary data={event.data} />;
  }

  if (event.type === 'run_finished') {
    return <RunFinishedSummary data={event.data} />;
  }

  if (event.type === 'error') {
    return (
      <p className='text-sm text-red-700 dark:text-red-300'>
        {String(event.data.message || 'Unknown error')}
      </p>
    );
  }

  return <JsonBlock value={event.data} />;
};

const UsageSummary: React.FC<{ data: Record<string, unknown> }> = ({
  data,
}) => (
  <div className='flex flex-wrap gap-2'>
    <MetricPill label='Provider' value={String(data.provider || 'unknown')} />
    <MetricPill label='Model' value={String(data.model || 'unknown')} />
    <MetricPill
      label='Input'
      value={`${formatCount(data.input_tokens)} tokens`}
    />
    <MetricPill
      label='Output'
      value={`${formatCount(data.output_tokens)} tokens`}
    />
    {toFiniteNumber(data.cached_tokens) > 0 && (
      <MetricPill
        label='Cached'
        value={`${formatCount(data.cached_tokens)} tokens`}
      />
    )}
    {toFiniteNumber(data.reasoning_tokens) > 0 && (
      <MetricPill
        label='Reasoning'
        value={`${formatCount(data.reasoning_tokens)} tokens`}
      />
    )}
    <MetricPill label='Cost' value={formatCost(data.cost)} />
  </div>
);

const RunFinishedSummary: React.FC<{ data: Record<string, unknown> }> = ({
  data,
}) => (
  <div className='flex flex-wrap gap-2'>
    <MetricPill label='State' value={String(data.state || 'done')} />
    {data.stop_reason !== undefined && (
      <MetricPill label='Stop reason' value={String(data.stop_reason)} />
    )}
  </div>
);

const MetricPill: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <span className='inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs text-gray-700 dark:border-dark-300 dark:bg-dark-100 dark:text-dark-700'>
    <span className='font-semibold text-gray-500 dark:text-dark-500'>
      {label}
    </span>
    <span>{value}</span>
  </span>
);

const JsonBlock: React.FC<{ value: unknown }> = ({ value }) => (
  <pre className='mt-2 max-h-56 overflow-auto rounded-lg bg-gray-100 p-2 text-xs text-gray-700 dark:bg-dark-200 dark:text-dark-700'>
    {JSON.stringify(value, null, 2)}
  </pre>
);

const EmptyState: React.FC<{ text: string }> = ({ text }) => (
  <div className='rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-8 text-center text-sm text-gray-500 dark:border-dark-300 dark:bg-dark-50 dark:text-dark-500'>
    {text}
  </div>
);

const formatDate = (value: string): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
};

const buildTimelineItems = (events: LibreClawEvent[]): TimelineItem[] => {
  const items: TimelineItem[] = [];
  let index = 0;

  while (index < events.length) {
    const event = events[index];
    if (!event) break;

    if (event.type === 'assistant_delta') {
      const group: LibreClawEvent[] = [];
      while (events[index]?.type === 'assistant_delta') {
        const delta = events[index];
        if (delta) group.push(delta);
        index += 1;
      }
      const first = group[0];
      const last = group[group.length - 1] || first;
      if (first && last) {
        items.push({
          key: `assistant-${first.event_id}-${last.event_id}`,
          kind: 'assistant_message',
          eventType: 'assistant_message',
          label: 'Assistant response',
          firstEventId: first.event_id,
          lastEventId: last.event_id,
          timestamp: first.timestamp,
          events: group,
        });
      }
      continue;
    }

    items.push({
      key: `${event.type}-${event.event_id}`,
      kind: 'event',
      eventType: event.type,
      label: formatEventLabel(event.type),
      firstEventId: event.event_id,
      lastEventId: event.event_id,
      timestamp: event.timestamp,
      events: [event],
    });
    index += 1;
  }

  return items;
};

const joinAssistantDeltas = (events: LibreClawEvent[]): string =>
  events.map(event => String(event.data.text || '')).join('');

const formatEventLabel = (type: string): string => {
  const labels: Record<string, string> = {
    user_message: 'User message',
    tool_call: 'Tool call',
    tool_result: 'Tool result',
    permission_request: 'Approval request',
    permission_response: 'Approval response',
    run_started: 'Run started',
    run_finished: 'Run finished',
    usage: 'Usage',
    error: 'Error',
  };
  return labels[type] || type.replace(/_/g, ' ');
};

const formatEventRange = (item: TimelineItem): string => {
  if (item.firstEventId === item.lastEventId) {
    return `#${item.firstEventId}`;
  }
  return `#${item.firstEventId}-#${item.lastEventId}`;
};

const toFiniteNumber = (value: unknown): number => {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const formatCount = (value: unknown): string =>
  new Intl.NumberFormat().format(toFiniteNumber(value));

const formatCost = (value: unknown): string => {
  const cost = toFiniteNumber(value);
  if (cost <= 0) return '$0.00';
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  return `$${cost.toFixed(4)}`;
};

export default LibreClawPage;
