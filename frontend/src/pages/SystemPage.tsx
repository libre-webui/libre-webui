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
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Box,
  Boxes,
  Clock3,
  Container,
  HardDrive,
  Loader2,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import { Button, PageHeader, PageShell } from '@/components/ui';
import { cn } from '@/utils';
import { systemApi, type SystemDiagnostics } from '@/utils/api';
import { workApi } from '@/utils/api/workApi';
import { RecoveryDrillsPanel } from '@/components/RecoveryDrillsPanel';

const bytesFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const numberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});
const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024))
  );
  return `${bytesFormatter.format(bytes / 1024 ** exponent)} ${units[exponent]}`;
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(seconds)}s`;
};

const boundedPercent = (value: number): number =>
  Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));

const statusClasses = (state: string): string => {
  switch (state.toLowerCase()) {
    case 'running':
      return 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
    case 'paused':
      return 'bg-amber-500/10 text-amber-700 dark:text-amber-300';
    case 'exited':
    case 'dead':
      return 'bg-gray-500/10 text-gray-600 dark:text-dark-600';
    default:
      return 'bg-primary-500/10 text-primary-700 dark:text-primary-300';
  }
};

const Panel: React.FC<
  React.PropsWithChildren<{
    title: string;
    description?: string;
    icon: React.ComponentType<{ className?: string }>;
    className?: string;
    action?: React.ReactNode;
  }>
> = ({ title, description, icon: Icon, className, action, children }) => (
  <section
    className={cn(
      'overflow-hidden rounded-2xl border border-gray-200/80 bg-white/80 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/75',
      className
    )}
  >
    <div className='flex items-start justify-between gap-4 border-b border-gray-200/70 px-4 py-3 dark:border-white/[0.07] sm:px-5'>
      <div className='flex min-w-0 items-start gap-3'>
        <div className='mt-0.5 rounded-xl bg-primary-500/10 p-1.5 text-primary-600 dark:text-primary-300'>
          <Icon className='h-4 w-4' />
        </div>
        <div className='min-w-0'>
          <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
            {title}
          </h2>
          {description && (
            <p className='mt-1 text-xs leading-5 text-gray-500 dark:text-dark-500'>
              {description}
            </p>
          )}
        </div>
      </div>
      {action}
    </div>
    {children}
  </section>
);

const DetailRow: React.FC<{
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}> = ({ label, value, mono }) => (
  <div className='flex min-w-0 items-start justify-between gap-5 border-b border-gray-100 py-2 last:border-0 dark:border-white/[0.05]'>
    <dt className='shrink-0 text-xs text-gray-500 dark:text-dark-500'>
      {label}
    </dt>
    <dd
      className={cn(
        'min-w-0 break-words text-end text-xs font-medium text-gray-800 dark:text-dark-800',
        mono && 'font-mono text-[11px]'
      )}
    >
      {value}
    </dd>
  </div>
);

const Meter: React.FC<{ value: number; tone?: 'primary' | 'warning' }> = ({
  value,
  tone = 'primary',
}) => (
  <div
    className='h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-dark-300'
    role='progressbar'
    aria-valuemin={0}
    aria-valuemax={100}
    aria-valuenow={Math.round(boundedPercent(value))}
  >
    <div
      className={cn(
        'h-full rounded-full transition-[width] duration-300',
        tone === 'warning'
          ? 'bg-amber-500 dark:bg-amber-400'
          : 'bg-primary-500 dark:bg-primary-400'
      )}
      style={{ width: `${boundedPercent(value)}%` }}
    />
  </div>
);

const WorkPanel: React.FC = () => {
  const { t } = useTranslation();
  const {
    data: overview,
    error,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['work-admin-overview'],
    queryFn: async () => {
      const response = await workApi.adminOverview();
      if (!response.success || !response.data) {
        throw new Error(response.error || t('systemPage.loadFailed'));
      }
      return response.data;
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  if (!overview) {
    // A failed overview is exactly when an administrator needs this panel;
    // show the failure instead of silently dropping the whole section.
    if (!error) return null;
    return (
      <Panel
        title={t('systemPage.work.title')}
        description={t('systemPage.work.description')}
        icon={Boxes}
      >
        <div className='flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5'>
          <div className='flex items-start gap-3 text-sm text-red-700 dark:text-red-300'>
            <TriangleAlert className='mt-0.5 h-4 w-4 shrink-0' />
            <p>
              {error instanceof Error && error.message
                ? error.message
                : t('systemPage.loadFailed')}
            </p>
          </div>
          <Button
            variant='outline'
            size='sm'
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            {t('common.retry')}
          </Button>
        </div>
      </Panel>
    );
  }

  const stateLabel = (running: boolean | null): string =>
    running === null
      ? t('systemPage.work.stateUnknown')
      : running
        ? t('systemPage.work.stateRunning')
        : t('systemPage.work.stateStopped');
  const previewLabel = (previewStatus: string): string =>
    previewStatus === 'running'
      ? t('systemPage.work.stateRunning')
      : previewStatus === 'starting'
        ? t('systemPage.work.stateStarting')
        : '—';

  return (
    <Panel
      title={t('systemPage.work.title')}
      description={t('systemPage.work.description')}
      icon={Boxes}
      action={
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em]',
            overview.runtimeAvailable
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'bg-gray-500/10 text-gray-600 dark:text-dark-600'
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              overview.runtimeAvailable ? 'bg-emerald-500' : 'bg-gray-400'
            )}
          />
          {overview.runtimeAvailable
            ? t('systemPage.work.runtimeAvailable')
            : t('systemPage.work.runtimeUnavailable')}
        </span>
      }
    >
      <div className='grid gap-3 border-b border-gray-200/70 p-4 dark:border-white/[0.07] sm:grid-cols-2 sm:p-5 lg:grid-cols-4'>
        {[
          [
            t('systemPage.work.access'),
            overview.accessMode === 'all-users'
              ? t('systemPage.work.accessAllUsers')
              : t('systemPage.work.accessAdmins'),
          ],
          [
            t('systemPage.work.activeRuntimes'),
            `${overview.admission.activeGlobal} / ${overview.admission.maxGlobal}`,
          ],
          [t('systemPage.work.pendingCleanups'), overview.recoveryPending],
          [t('systemPage.work.orphans'), overview.orphanContainers.length],
        ].map(([label, value]) => (
          <div
            key={String(label)}
            className='rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-dark-200/70'
          >
            <div className='text-[11px] text-gray-500 dark:text-dark-500'>
              {label}
            </div>
            <div className='mt-1 text-xl text-gray-950 dark:text-dark-950'>
              {value}
            </div>
          </div>
        ))}
      </div>

      {!overview.runtimeAvailable && overview.runtimeReason && (
        <div className='mx-4 mt-4 flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-600 dark:border-white/[0.07] dark:bg-dark-200/60 dark:text-dark-600 sm:mx-5'>
          <TriangleAlert className='mt-0.5 h-4 w-4 shrink-0' />
          <p>{overview.runtimeReason}</p>
        </div>
      )}

      {overview.tasks.length === 0 ? (
        <p className='px-4 py-4 text-sm text-gray-500 dark:text-dark-500 sm:px-5'>
          {t('systemPage.work.noTasks')}
        </p>
      ) : (
        <div className='overflow-x-auto'>
          <table
            data-testid='system-work-table'
            className='w-full min-w-[760px] text-sm'
          >
            <thead className='text-[11px] uppercase tracking-[0.1em] text-gray-400 dark:text-dark-500'>
              <tr>
                <th className='px-5 py-2 text-start font-medium'>
                  {t('systemPage.work.owner')}
                </th>
                <th className='px-4 py-2 text-start font-medium'>
                  {t('systemPage.work.task')}
                </th>
                <th className='px-4 py-2 text-start font-medium'>
                  {t('systemPage.work.state')}
                </th>
                <th className='px-4 py-2 text-start font-medium'>
                  {t('systemPage.work.preview')}
                </th>
                <th className='px-4 py-2 text-start font-medium'>
                  {t('systemPage.work.terminals')}
                </th>
                <th className='px-5 py-2 text-end font-medium'>
                  {t('systemPage.work.updated')}
                </th>
              </tr>
            </thead>
            <tbody className='divide-y divide-gray-100 dark:divide-white/[0.06]'>
              {overview.tasks.map(task => (
                <tr key={task.id}>
                  <td className='px-5 py-2.5 text-gray-800 dark:text-dark-800'>
                    {task.ownerUsername}
                  </td>
                  <td className='px-4 py-2.5'>
                    <div className='font-medium text-gray-900 dark:text-dark-900'>
                      {task.title}
                    </div>
                    <div className='mt-0.5 font-mono text-[10px] text-gray-500 dark:text-dark-500'>
                      {task.model}
                    </div>
                  </td>
                  <td className='px-4 py-2.5'>
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 text-xs',
                        task.running
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-gray-600 dark:text-dark-600'
                      )}
                    >
                      <span
                        className={cn(
                          'h-1.5 w-1.5 rounded-full',
                          task.running === null
                            ? 'bg-amber-400'
                            : task.running
                              ? 'bg-emerald-500'
                              : 'bg-gray-400'
                        )}
                      />
                      {stateLabel(task.running)}
                    </span>
                  </td>
                  <td className='px-4 py-2.5 text-xs text-gray-600 dark:text-dark-600'>
                    {previewLabel(task.previewStatus)}
                  </td>
                  <td className='px-4 py-2.5 text-xs text-gray-600 dark:text-dark-600'>
                    {task.terminalSessions}
                  </td>
                  <td className='px-5 py-2.5 text-end text-xs text-gray-600 dark:text-dark-600'>
                    {dateFormatter.format(task.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
};

const SystemPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    data: diagnostics,
    error,
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['system-diagnostics'],
    queryFn: async () => {
      const response = await systemApi.getDiagnostics();
      if (!response.success || !response.data) {
        throw new Error(response.error || t('systemPage.loadFailed'));
      }
      return response.data;
    },
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : t('systemPage.loadFailed')
    : null;

  if (isLoading && !diagnostics) {
    return (
      <PageShell width='wide'>
        <div className='flex min-h-[50vh] items-center justify-center'>
          <Loader2 className='h-7 w-7 animate-spin text-primary-500' />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell width='wide'>
      <PageHeader
        eyebrow={t('systemPage.eyebrow')}
        title={t('systemPage.title')}
        description={t('systemPage.description')}
        actions={
          <div className='flex items-center gap-3'>
            {diagnostics && (
              <span className='hidden text-xs text-gray-500 dark:text-dark-500 sm:inline'>
                {t('systemPage.updated', {
                  date: dateFormatter.format(diagnostics.generatedAt),
                })}
              </span>
            )}
            <Button
              variant='outline'
              size='sm'
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw
                className={cn('h-4 w-4', isFetching && 'animate-spin')}
              />
              <span className='sr-only'>{t('systemPage.refresh')}</span>
            </Button>
          </div>
        }
      />

      {errorMessage && (
        <div className='mb-6 flex items-center gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300'>
          <TriangleAlert className='h-4 w-4 shrink-0' />
          <span>{errorMessage}</span>
        </div>
      )}

      {diagnostics && (
        <div data-testid='system-dashboard' className='space-y-4'>
          <SummaryCards diagnostics={diagnostics} />

          <div className='grid gap-4 xl:grid-cols-2'>
            <HostPanel diagnostics={diagnostics} />
            <MemoryPanel diagnostics={diagnostics} />
          </div>

          <StoragePanel diagnostics={diagnostics} />
          <DockerPanel diagnostics={diagnostics} />
          <WorkPanel />
          <RecoveryDrillsPanel />
          <NetworkPanel diagnostics={diagnostics} />

          <div className='flex items-start gap-2 px-1 text-xs leading-5 text-gray-500 dark:text-dark-500'>
            <ShieldCheck className='mt-0.5 h-4 w-4 shrink-0 text-primary-500' />
            <p>{t('systemPage.securityNote')}</p>
          </div>
        </div>
      )}
    </PageShell>
  );
};

const SummaryCards: React.FC<{ diagnostics: SystemDiagnostics }> = ({
  diagnostics,
}) => {
  const { t } = useTranslation();
  const primaryFilesystem =
    diagnostics.filesystems.find(item => item.label === 'Data directory') ??
    diagnostics.filesystems[0];
  const cards = [
    {
      label: t('systemPage.cards.uptime'),
      value: formatDuration(diagnostics.host.uptimeSeconds),
      detail: t('systemPage.cards.uptimeDetail', {
        date: dateFormatter.format(diagnostics.host.bootedAt),
      }),
      icon: Clock3,
    },
    {
      label: t('systemPage.cards.memory'),
      value: `${numberFormatter.format(diagnostics.memory.usedPercent)}%`,
      detail: t('systemPage.cards.memoryDetail', {
        used: formatBytes(diagnostics.memory.usedBytes),
        total: formatBytes(diagnostics.memory.totalBytes),
      }),
      icon: MemoryStick,
    },
    {
      label: t('systemPage.cards.freeSpace'),
      value: primaryFilesystem ? formatBytes(primaryFilesystem.freeBytes) : '—',
      detail: primaryFilesystem
        ? t('systemPage.cards.freeSpaceDetail', {
            label: primaryFilesystem.label,
            total: formatBytes(primaryFilesystem.totalBytes),
          })
        : t('systemPage.cards.unavailable'),
      icon: HardDrive,
    },
    {
      label: t('systemPage.cards.containers'),
      value: diagnostics.docker.available
        ? String(diagnostics.docker.runningContainers)
        : '—',
      detail: diagnostics.docker.available
        ? t('systemPage.cards.containersDetail', {
            total: diagnostics.docker.totalContainers,
          })
        : t('systemPage.cards.dockerUnavailable'),
      icon: Container,
    },
  ];

  return (
    <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-4'>
      {cards.map(card => {
        const Icon = card.icon;
        return (
          <section
            key={card.label}
            className='rounded-2xl border border-gray-200/80 bg-white/75 p-4 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/70'
          >
            <div className='flex items-center justify-between gap-3'>
              <span className='text-xs font-medium uppercase tracking-[0.12em] text-gray-500 dark:text-dark-500'>
                {card.label}
              </span>
              <Icon className='h-4 w-4 text-primary-500 dark:text-primary-400' />
            </div>
            <div className='mt-2 text-2xl font-normal tracking-[-0.04em] text-gray-950 dark:text-dark-950'>
              {card.value}
            </div>
            <p className='mt-1.5 text-xs text-gray-500 dark:text-dark-500'>
              {card.detail}
            </p>
          </section>
        );
      })}
    </div>
  );
};

const HostPanel: React.FC<{ diagnostics: SystemDiagnostics }> = ({
  diagnostics,
}) => {
  const { t } = useTranslation();
  const { host, runtime } = diagnostics;
  return (
    <Panel
      title={t('systemPage.host.title')}
      description={t('systemPage.host.description')}
      icon={Server}
      action={
        <span className='rounded-full bg-primary-500/10 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em] text-primary-700 dark:text-primary-300'>
          {host.containerized
            ? t('systemPage.host.container')
            : t('systemPage.host.native')}
        </span>
      }
    >
      <dl className='px-4 py-2 sm:px-5'>
        <DetailRow
          label={t('systemPage.host.hostname')}
          value={host.hostname}
        />
        <DetailRow
          label={t('systemPage.host.operatingSystem')}
          value={`${host.platform} ${host.release} · ${host.architecture}`}
        />
        <DetailRow
          label={t('systemPage.host.processor')}
          value={`${host.cpuModel} · ${host.logicalCpus} ${t('systemPage.host.logicalCpus')}`}
        />
        <DetailRow
          label={t('systemPage.host.loadAverage')}
          value={host.loadAverage
            .map(value => numberFormatter.format(value))
            .join(' · ')}
        />
        <DetailRow
          label={t('systemPage.host.libreVersion')}
          value={runtime.appVersion}
        />
        <DetailRow
          label={t('systemPage.host.nodeVersion')}
          value={runtime.nodeVersion}
        />
        <DetailRow
          label={t('systemPage.host.process')}
          value={`PID ${runtime.processId} · ${formatDuration(runtime.processUptimeSeconds)}`}
        />
        <DetailRow
          label={t('systemPage.host.workingDirectory')}
          value={runtime.workingDirectory}
          mono
        />
      </dl>
    </Panel>
  );
};

const MemoryPanel: React.FC<{ diagnostics: SystemDiagnostics }> = ({
  diagnostics,
}) => {
  const { t } = useTranslation();
  const { memory } = diagnostics;
  return (
    <Panel
      title={t('systemPage.memory.title')}
      description={t('systemPage.memory.description')}
      icon={MemoryStick}
    >
      <div className='space-y-4 p-4 sm:p-5'>
        <div>
          <div className='mb-2 flex items-end justify-between gap-4'>
            <div>
              <div className='text-2xl tracking-[-0.04em] text-gray-950 dark:text-dark-950'>
                {numberFormatter.format(memory.usedPercent)}%
              </div>
              <div className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
                {t('systemPage.memory.usedOf', {
                  used: formatBytes(memory.usedBytes),
                  total: formatBytes(memory.totalBytes),
                })}
              </div>
            </div>
            <span className='text-xs tabular-nums text-gray-500 dark:text-dark-500'>
              {t('systemPage.memory.free', {
                value: formatBytes(memory.freeBytes),
              })}
            </span>
          </div>
          <Meter
            value={memory.usedPercent}
            tone={memory.usedPercent >= 85 ? 'warning' : 'primary'}
          />
        </div>
        <div className='grid grid-cols-2 gap-3'>
          {[
            [t('systemPage.memory.processRss'), memory.processRssBytes],
            [t('systemPage.memory.heapUsed'), memory.heapUsedBytes],
            [t('systemPage.memory.heapTotal'), memory.heapTotalBytes],
            [t('systemPage.memory.external'), memory.externalBytes],
          ].map(([label, value]) => (
            <div
              key={String(label)}
              className='rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-dark-200/70'
            >
              <div className='text-[11px] text-gray-500 dark:text-dark-500'>
                {label}
              </div>
              <div className='mt-1 text-lg text-gray-950 dark:text-dark-950'>
                {formatBytes(Number(value))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
};

const StoragePanel: React.FC<{ diagnostics: SystemDiagnostics }> = ({
  diagnostics,
}) => {
  const { t } = useTranslation();
  return (
    <Panel
      title={t('systemPage.storage.title')}
      description={t('systemPage.storage.description')}
      icon={HardDrive}
    >
      {diagnostics.filesystems.length === 0 ? (
        <p className='p-5 text-sm text-gray-500 dark:text-dark-500'>
          {t('systemPage.storage.empty')}
        </p>
      ) : (
        <div className='grid gap-3 p-4 sm:grid-cols-2 sm:p-5'>
          {diagnostics.filesystems.map(filesystem => (
            <div
              key={`${filesystem.label}:${filesystem.path}`}
              className='rounded-xl border border-gray-200/80 bg-gray-50/70 p-4 dark:border-white/[0.06] dark:bg-dark-200/55'
            >
              <div className='flex items-start justify-between gap-4'>
                <div className='min-w-0'>
                  <h3 className='text-sm font-medium text-gray-900 dark:text-dark-900'>
                    {filesystem.label}
                  </h3>
                  <p className='mt-1 truncate font-mono text-[10px] text-gray-500 dark:text-dark-500'>
                    {filesystem.path}
                  </p>
                </div>
                <span className='shrink-0 text-sm tabular-nums text-gray-700 dark:text-dark-700'>
                  {numberFormatter.format(filesystem.usedPercent)}%
                </span>
              </div>
              <div className='mt-4'>
                <Meter
                  value={filesystem.usedPercent}
                  tone={filesystem.usedPercent >= 85 ? 'warning' : 'primary'}
                />
              </div>
              <div className='mt-3 flex justify-between gap-4 text-[11px] text-gray-500 dark:text-dark-500'>
                <span>
                  {t('systemPage.storage.used', {
                    value: formatBytes(filesystem.usedBytes),
                  })}
                </span>
                <span>
                  {t('systemPage.storage.free', {
                    value: formatBytes(filesystem.freeBytes),
                  })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
};

const DockerPanel: React.FC<{ diagnostics: SystemDiagnostics }> = ({
  diagnostics,
}) => {
  const { t } = useTranslation();
  const { docker } = diagnostics;
  return (
    <Panel
      title={t('systemPage.docker.title')}
      description={t('systemPage.docker.description')}
      icon={Container}
      action={
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.1em]',
            docker.available
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'bg-gray-500/10 text-gray-600 dark:text-dark-600'
          )}
        >
          <span
            className={cn(
              'h-1.5 w-1.5 rounded-full',
              docker.available ? 'bg-emerald-500' : 'bg-gray-400'
            )}
          />
          {docker.available
            ? t('systemPage.docker.connected')
            : t('systemPage.docker.unavailable')}
        </span>
      }
    >
      {!docker.available ? (
        <div className='m-4 flex items-start gap-3 rounded-xl border border-gray-200 bg-gray-50 px-4 py-4 text-sm text-gray-600 dark:border-white/[0.07] dark:bg-dark-200/60 dark:text-dark-600 sm:m-5'>
          <TriangleAlert className='mt-0.5 h-4 w-4 shrink-0' />
          <div>
            <p>{docker.reason || t('systemPage.docker.unavailableDetail')}</p>
            <p className='mt-2 text-xs text-gray-500 dark:text-dark-500'>
              {t('systemPage.docker.socketStatus', {
                status: docker.socketMounted
                  ? t('systemPage.docker.mounted')
                  : t('systemPage.docker.notMounted'),
              })}
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className='grid gap-3 border-b border-gray-200/70 p-4 dark:border-white/[0.07] sm:grid-cols-2 sm:p-5 lg:grid-cols-4'>
            {[
              [t('systemPage.docker.running'), docker.runningContainers],
              [t('systemPage.docker.stopped'), docker.stoppedContainers],
              [t('systemPage.docker.paused'), docker.pausedContainers],
              [t('systemPage.docker.total'), docker.totalContainers],
            ].map(([label, value]) => (
              <div
                key={String(label)}
                className='rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-dark-200/70'
              >
                <div className='text-[11px] text-gray-500 dark:text-dark-500'>
                  {label}
                </div>
                <div className='mt-1 text-xl text-gray-950 dark:text-dark-950'>
                  {value}
                </div>
              </div>
            ))}
          </div>

          <div className='flex flex-wrap gap-2 px-4 py-4 sm:px-5'>
            {docker.serverVersion && (
              <EnginePill
                label={t('systemPage.docker.version')}
                value={docker.serverVersion}
              />
            )}
            {docker.operatingSystem && (
              <EnginePill
                label={t('systemPage.docker.host')}
                value={docker.operatingSystem}
              />
            )}
            {docker.architecture && (
              <EnginePill
                label={t('systemPage.docker.architecture')}
                value={docker.architecture}
              />
            )}
            {docker.logicalCpus !== undefined && (
              <EnginePill
                label={t('systemPage.docker.cpus')}
                value={String(docker.logicalCpus)}
              />
            )}
            {docker.memoryBytes !== undefined && (
              <EnginePill
                label={t('systemPage.docker.memory')}
                value={formatBytes(docker.memoryBytes)}
              />
            )}
          </div>

          {docker.containers.length === 0 ? (
            <p className='px-5 pb-5 text-sm text-gray-500 dark:text-dark-500'>
              {t('systemPage.docker.empty')}
            </p>
          ) : (
            <div className='overflow-x-auto border-t border-gray-200/70 dark:border-white/[0.07]'>
              <table
                data-testid='system-docker-table'
                className='w-full min-w-[760px] text-sm'
              >
                <thead className='text-[11px] uppercase tracking-[0.1em] text-gray-400 dark:text-dark-500'>
                  <tr>
                    <th className='px-5 py-2 text-start font-medium'>
                      {t('systemPage.docker.container')}
                    </th>
                    <th className='px-4 py-2 text-start font-medium'>
                      {t('systemPage.docker.image')}
                    </th>
                    <th className='px-4 py-2 text-start font-medium'>
                      {t('systemPage.docker.state')}
                    </th>
                    <th className='px-5 py-2 text-end font-medium'>
                      {t('systemPage.docker.created')}
                    </th>
                  </tr>
                </thead>
                <tbody className='divide-y divide-gray-100 dark:divide-white/[0.06]'>
                  {docker.containers.map(container => (
                    <tr key={container.id}>
                      <td className='px-5 py-2.5'>
                        <div className='font-medium text-gray-900 dark:text-dark-900'>
                          {container.name}
                        </div>
                        <div className='mt-0.5 font-mono text-[10px] text-gray-500 dark:text-dark-500'>
                          {container.id}
                        </div>
                      </td>
                      <td className='max-w-[280px] px-4 py-2.5'>
                        <div
                          className='truncate font-mono text-[11px] text-gray-600 dark:text-dark-600'
                          title={container.image}
                        >
                          {container.image}
                        </div>
                      </td>
                      <td className='px-4 py-2.5'>
                        <span
                          className={cn(
                            'inline-flex rounded-full px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.08em]',
                            statusClasses(container.state)
                          )}
                        >
                          {container.state}
                        </span>
                        <div className='mt-1.5 text-[11px] text-gray-500 dark:text-dark-500'>
                          {container.status}
                        </div>
                      </td>
                      <td className='px-5 py-2.5 text-end text-xs text-gray-500 dark:text-dark-500'>
                        {container.createdAt
                          ? dateFormatter.format(container.createdAt)
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Panel>
  );
};

const EnginePill: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <span className='rounded-full border border-gray-200 bg-white px-3 py-1.5 text-[11px] text-gray-600 dark:border-white/[0.07] dark:bg-dark-200/70 dark:text-dark-600'>
    <span className='text-gray-400 dark:text-dark-500'>{label}</span> {value}
  </span>
);

const NetworkPanel: React.FC<{ diagnostics: SystemDiagnostics }> = ({
  diagnostics,
}) => {
  const { t } = useTranslation();
  return (
    <Panel
      title={t('systemPage.network.title')}
      description={t('systemPage.network.description')}
      icon={Network}
    >
      {diagnostics.network.interfaces.length === 0 ? (
        <p className='p-5 text-sm text-gray-500 dark:text-dark-500'>
          {t('systemPage.network.empty')}
        </p>
      ) : (
        <div className='grid gap-3 p-4 sm:grid-cols-2 sm:p-5 xl:grid-cols-3'>
          {diagnostics.network.interfaces.map(networkInterface => (
            <div
              key={networkInterface.name}
              className='rounded-xl border border-gray-200/80 bg-gray-50/70 p-4 dark:border-white/[0.06] dark:bg-dark-200/55'
            >
              <div className='flex items-center gap-2'>
                <Box className='h-4 w-4 text-primary-500' />
                <h3 className='font-mono text-xs font-medium text-gray-900 dark:text-dark-900'>
                  {networkInterface.name}
                </h3>
              </div>
              <div className='mt-3 space-y-2'>
                {networkInterface.addresses.map(address => (
                  <div
                    key={`${address.family}:${address.address}`}
                    className='min-w-0 rounded-xl bg-white px-3 py-2 dark:bg-dark-100/80'
                  >
                    <div className='flex items-center justify-between gap-3'>
                      <span className='text-[10px] font-medium uppercase tracking-[0.08em] text-gray-400 dark:text-dark-500'>
                        {address.family}
                      </span>
                      {address.internal && (
                        <span className='text-[10px] text-gray-400 dark:text-dark-500'>
                          {t('systemPage.network.internal')}
                        </span>
                      )}
                    </div>
                    <div className='mt-1 break-all font-mono text-[11px] text-gray-700 dark:text-dark-700'>
                      {address.cidr || address.address}
                    </div>
                  </div>
                ))}
              </div>
              {(networkInterface.receivedBytes !== undefined ||
                networkInterface.transmittedBytes !== undefined) && (
                <div className='mt-3 flex justify-between gap-4 text-[10px] text-gray-500 dark:text-dark-500'>
                  <span>
                    ↓ {formatBytes(networkInterface.receivedBytes ?? 0)}
                  </span>
                  <span>
                    ↑ {formatBytes(networkInterface.transmittedBytes ?? 0)}
                  </span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
};

export default SystemPage;
