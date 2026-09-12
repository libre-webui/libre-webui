/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  Bot,
  CheckCircle2,
  Clock3,
  Gauge,
  Loader2,
  RefreshCw,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { Button, PageHeader, PageShell } from '@/components/ui';
import { CostGovernancePanel } from '@/components/CostGovernancePanel';
import { pluginApi, type PluginUsageAnalytics } from '@/utils/api';
import { cn } from '@/utils';
import { UsageChart, type ChartMetric } from '@/components/usage/UsageChart';
import {
  getUsageChartSeries,
  getUsageModelColors,
  getProviderModelSegments,
  matchesUsageSnapshot,
  OTHER_MODEL_COLOR,
  usageModelKey,
} from '@/utils/pluginUsage';

const integerFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});
const compactFormatter = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const formatCount = (value: number): string =>
  value >= 10_000
    ? compactFormatter.format(value)
    : integerFormatter.format(value);

const formatLatency = (milliseconds: number): string => {
  if (!milliseconds) return '—';
  if (milliseconds < 1000) return `${integerFormatter.format(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
};

const successRate = (calls: number, errors: number): number =>
  calls === 0 ? 0 : ((calls - errors) / calls) * 100;

const DAY_MS = 24 * 60 * 60 * 1000;
const CELL = 10;
const CELL_GAP = 2;
const CELL_PITCH = CELL + CELL_GAP;
const HEATMAP_LEFT_PAD = 30;
const HEATMAP_TOP_PAD = 16;

const EMPTY_FILL = 'fill-gray-950/[0.06] dark:fill-white/[0.07]';
const INTENSITY_OPACITY = [0, 0.35, 0.55, 0.75, 1];

interface HeatmapTooltip {
  x: number;
  y: number;
  timestamp: number;
  calls: number;
  models: Array<{ model: string; calls: number }>;
}

const UsageHeatmap: React.FC<{
  heatmap: NonNullable<PluginUsageAnalytics['heatmap']>;
  colors: Map<string, string>;
  chartModels: string[];
  focusedModel?: string;
}> = ({ heatmap, colors, chartModels, focusedModel }) => {
  const { t, i18n } = useTranslation();
  const [tooltip, setTooltip] = useState<HeatmapTooltip | null>(null);
  const visibleModels = [...new Set([...heatmap.models, ...chartModels])];
  const colorFor = (model: string | undefined): string =>
    model !== undefined &&
    (visibleModels.includes(model) || model === focusedModel)
      ? (colors.get(usageModelKey(model)) ?? OTHER_MODEL_COLOR)
      : OTHER_MODEL_COLOR;

  const { weeks, firstColStart, cellsByDay, maxCalls, totalCalls } =
    useMemo(() => {
      const cellsByDay = new Map(
        heatmap.cells.map(cell => [cell.timestamp, cell])
      );
      const start = heatmap.from;
      const end = heatmap.from + (heatmap.days - 1) * DAY_MS;
      const firstColStart = start - new Date(start).getUTCDay() * DAY_MS;
      const weeks = Math.ceil((end - firstColStart + DAY_MS) / (7 * DAY_MS));
      const maxCalls = Math.max(1, ...heatmap.cells.map(cell => cell.calls));
      const totalCalls = heatmap.cells.reduce(
        (sum, cell) => sum + cell.calls,
        0
      );
      return {
        weeks,
        firstColStart,
        cellsByDay,
        maxCalls,
        totalCalls,
      };
    }, [heatmap]);

  const monthFormatter = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    timeZone: 'UTC',
  });
  const weekdayFormatter = new Intl.DateTimeFormat(i18n.language, {
    weekday: 'short',
    timeZone: 'UTC',
  });
  const dateFormatter = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'medium',
    timeZone: 'UTC',
  });

  const start = heatmap.from;
  const end = heatmap.from + (heatmap.days - 1) * DAY_MS;
  const width = HEATMAP_LEFT_PAD + weeks * CELL_PITCH;
  const height = HEATMAP_TOP_PAD + 7 * CELL_PITCH;

  const monthLabels: Array<{ x: number; label: string }> = [];
  let lastMonth = -1;
  for (let week = 0; week < weeks; week++) {
    const columnStart = firstColStart + week * 7 * DAY_MS;
    const visibleStart = Math.max(columnStart, start);
    const month = new Date(visibleStart).getUTCMonth();
    if (month !== lastMonth && columnStart >= start - 6 * DAY_MS) {
      if (lastMonth !== -1 || columnStart >= start) {
        monthLabels.push({
          x: HEATMAP_LEFT_PAD + week * CELL_PITCH,
          label: monthFormatter.format(visibleStart),
        });
      }
      lastMonth = month;
    }
  }

  const intensity = (calls: number): number =>
    calls <= 0
      ? 0
      : Math.min(4, Math.max(1, Math.ceil((calls / maxCalls) * 4)));

  const fillFor = (cell: { models: Array<{ model: string }> }): string =>
    colorFor(cell.models[0]?.model);

  const showTooltip = (
    event: React.MouseEvent<SVGRectElement>,
    timestamp: number,
    cell: { calls: number; models: Array<{ model: string; calls: number }> }
  ) => {
    const wrapper = event.currentTarget.closest('[data-heatmap-wrapper]');
    if (!wrapper) return;
    const bounds = wrapper.getBoundingClientRect();
    const rect = event.currentTarget.getBoundingClientRect();
    const rawX = rect.left - bounds.left + rect.width / 2;
    setTooltip({
      // Keep the tooltip inside the card near the edges of the grid.
      x: Math.min(Math.max(rawX, 96), Math.max(bounds.width - 96, 96)),
      y: rect.top - bounds.top,
      timestamp,
      calls: cell.calls,
      models: cell.models,
    });
  };

  return (
    <section
      data-testid='usage-heatmap'
      className='min-w-0 overflow-hidden rounded-2xl border border-gray-200/80 bg-white/80 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/75'
    >
      <div className='flex flex-col gap-1 border-b border-gray-200/70 px-4 py-3 dark:border-white/[0.07] sm:flex-row sm:items-center sm:justify-between sm:px-5'>
        <div>
          <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
            {t('usageAnalytics.heatmap.title')}
          </h2>
          <p className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
            {t('usageAnalytics.heatmap.description')}
          </p>
        </div>
        <span className='shrink-0 text-xs tabular-nums text-gray-500 dark:text-dark-500'>
          {t('usageAnalytics.heatmap.yearTotal', {
            count: totalCalls,
            formatted: formatCount(totalCalls),
          })}
        </span>
      </div>
      <div className='relative p-4 sm:px-5' data-heatmap-wrapper>
        <div className='overflow-x-auto'>
          <svg
            viewBox={`0 0 ${width} ${height}`}
            direction='ltr'
            className='h-auto w-full min-w-[640px]'
            role='img'
            aria-label={t('usageAnalytics.heatmap.title')}
            onMouseLeave={() => setTooltip(null)}
          >
            {monthLabels.map(({ x, label }) => (
              <text
                key={`${x}-${label}`}
                x={x}
                y={10}
                className='fill-gray-400 text-[8px] dark:fill-dark-500'
              >
                {label}
              </text>
            ))}
            {[1, 3, 5].map(day => (
              <text
                key={day}
                x={0}
                y={HEATMAP_TOP_PAD + day * CELL_PITCH + CELL - 2}
                className='fill-gray-400 text-[8px] dark:fill-dark-500'
              >
                {weekdayFormatter.format(
                  // A known Sunday plus the row offset yields the weekday name.
                  new Date(Date.UTC(2023, 0, 1 + day))
                )}
              </text>
            ))}
            {Array.from({ length: weeks }, (_, week) =>
              Array.from({ length: 7 }, (_, day) => {
                const timestamp = firstColStart + (week * 7 + day) * DAY_MS;
                if (timestamp < start || timestamp > end) return null;
                const cell = cellsByDay.get(timestamp);
                const calls = cell?.calls ?? 0;
                const level = intensity(calls);
                return (
                  <rect
                    key={timestamp}
                    x={HEATMAP_LEFT_PAD + week * CELL_PITCH}
                    y={HEATMAP_TOP_PAD + day * CELL_PITCH}
                    width={CELL}
                    height={CELL}
                    rx={2}
                    data-model={cell?.models[0]?.model}
                    fill={cell && level > 0 ? fillFor(cell) : undefined}
                    fillOpacity={level === 0 ? 1 : INTENSITY_OPACITY[level]}
                    strokeWidth={tooltip?.timestamp === timestamp ? 1 : 0}
                    className={cn(
                      'motion-safe:transition-opacity',
                      (level === 0 || !cell) && EMPTY_FILL,
                      tooltip?.timestamp === timestamp
                        ? 'stroke-gray-500 dark:stroke-white/60'
                        : 'stroke-transparent'
                    )}
                    onMouseEnter={event =>
                      showTooltip(event, timestamp, {
                        calls,
                        models: cell?.models ?? [],
                      })
                    }
                  >
                    <title>
                      {`${dateFormatter.format(timestamp)} — ${formatCount(calls)}`}
                    </title>
                  </rect>
                );
              })
            )}
          </svg>
        </div>
        {tooltip && (
          <div
            className='pointer-events-none absolute z-10 min-w-[10rem] -translate-x-1/2 -translate-y-full rounded-lg border border-gray-200/80 bg-white/95 px-3 py-2 shadow-card backdrop-blur-md dark:border-white/[0.1] dark:bg-dark-100/95'
            style={{ left: tooltip.x, top: tooltip.y - 6 }}
          >
            <div className='text-[11px] font-medium text-gray-900 dark:text-dark-900'>
              {dateFormatter.format(tooltip.timestamp)}
            </div>
            <div className='mt-0.5 text-[11px] text-gray-500 dark:text-dark-500'>
              {tooltip.calls === 0
                ? t('usageAnalytics.heatmap.noCalls')
                : `${formatCount(tooltip.calls)} ${t('usageAnalytics.heatmap.calls')}`}
            </div>
            {tooltip.models.slice(0, 3).map(entry => (
              <div
                key={entry.model}
                className='mt-1 flex items-center justify-between gap-3 text-[11px]'
              >
                <span className='flex min-w-0 items-center gap-1.5'>
                  <span
                    className='h-2 w-2 shrink-0 rounded-[3px]'
                    style={{
                      backgroundColor: colorFor(entry.model),
                    }}
                  />
                  <span
                    className='truncate font-mono text-gray-700 dark:text-dark-700'
                    dir='ltr'
                  >
                    {entry.model}
                  </span>
                </span>
                <span className='tabular-nums text-gray-500 dark:text-dark-500'>
                  {formatCount(entry.calls)}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className='mt-3 flex flex-wrap items-center justify-between gap-3'>
          <div className='flex flex-wrap items-center gap-x-4 gap-y-1.5'>
            {visibleModels.map(model => (
              <span
                key={model}
                className='flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-dark-600'
              >
                <span
                  className='h-2.5 w-2.5 rounded-[3px]'
                  style={{
                    backgroundColor:
                      colors.get(usageModelKey(model)) ?? OTHER_MODEL_COLOR,
                  }}
                />
                <span className='font-mono' dir='ltr'>
                  {model}
                </span>
              </span>
            ))}
            <span className='flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-dark-600'>
              <span
                className='h-2.5 w-2.5 rounded-[3px]'
                style={{ backgroundColor: OTHER_MODEL_COLOR }}
              />
              {t('usageAnalytics.heatmap.other')}
            </span>
          </div>
          <div className='flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-dark-500'>
            {t('usageAnalytics.heatmap.less')}
            <span className='h-2.5 w-2.5 rounded-[3px] bg-gray-950/[0.06] dark:bg-white/[0.07]' />
            {INTENSITY_OPACITY.slice(1).map(opacity => (
              <span
                key={opacity}
                className='h-2.5 w-2.5 rounded-[3px] bg-gray-500'
                style={{ opacity }}
              />
            ))}
            {t('usageAnalytics.heatmap.more')}
          </div>
        </div>
      </div>
    </section>
  );
};

const PluginUsagePage: React.FC = () => {
  const { t } = useTranslation();
  const [days, setDays] = useState(30);
  const [metric, setMetric] = useState<ChartMetric>('calls');
  const [selectedModel, setSelectedModel] = useState<string>();
  const [previewModel, setPreviewModel] = useState<string>();
  const {
    data: overviewAnalytics,
    error,
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['plugin-usage', days],
    queryFn: async () => {
      const response = await pluginApi.getUsage(days);
      if (!response.success || !response.data) {
        throw new Error(response.error || t('usageAnalytics.loadFailed'));
      }
      return response.data;
    },
  });
  const overviewKeys = useMemo(
    () =>
      new Set(
        overviewAnalytics
          ? getUsageChartSeries(overviewAnalytics).map(series => series.key)
          : []
      ),
    [overviewAnalytics]
  );
  const availableModelKeys = useMemo(
    () =>
      new Set([
        ...overviewKeys,
        ...(overviewAnalytics?.models.map(entry =>
          usageModelKey(entry.model)
        ) ?? []),
      ]),
    [overviewKeys, overviewAnalytics]
  );
  const selected =
    selectedModel && availableModelKeys.has(selectedModel)
      ? selectedModel
      : undefined;
  const preview =
    previewModel && availableModelKeys.has(previewModel)
      ? previewModel
      : undefined;
  const canLoadModels = overviewKeys.has('other');
  const focusKey = canLoadModels
    ? [preview, selected].find(
        key => key?.startsWith('model:') && !overviewKeys.has(key)
      )
    : undefined;
  const focusModel = focusKey?.slice('model:'.length);
  const focusedQuery = useQuery({
    queryKey: [
      'plugin-usage',
      days,
      'model',
      focusModel,
      overviewAnalytics?.range.to,
    ],
    enabled: focusModel !== undefined,
    staleTime: 30_000,
    queryFn: async () => {
      const response = await pluginApi.getUsage(
        days,
        focusModel,
        overviewAnalytics?.range.to
      );
      if (!response.success || !response.data)
        throw new Error(response.error || t('usageAnalytics.loadFailed'));
      return response.data;
    },
  });
  const analytics = overviewAnalytics;
  const focusedMatches =
    !!overviewAnalytics &&
    !!focusedQuery.data &&
    matchesUsageSnapshot(overviewAnalytics, focusedQuery.data);
  const chartAnalytics = useMemo(
    () =>
      overviewAnalytics && focusModel !== undefined && focusedMatches
        ? { ...overviewAnalytics, modelSeries: focusedQuery.data!.modelSeries }
        : overviewAnalytics,
    [overviewAnalytics, focusModel, focusedMatches, focusedQuery.data]
  );
  const reconciledResponse = useRef<PluginUsageAnalytics | null>(null);
  useEffect(() => {
    if (
      focusModel !== undefined &&
      focusedQuery.data &&
      !focusedMatches &&
      !isFetching &&
      reconciledResponse.current !== focusedQuery.data
    ) {
      // Historical backfills or deletions can change a timestamp-bounded view.
      // Refresh the shared overview once before overlaying incompatible data.
      reconciledResponse.current = focusedQuery.data;
      void refetch();
    }
  }, [focusModel, focusedQuery.data, focusedMatches, isFetching, refetch]);
  const viewError =
    error ?? (focusModel !== undefined ? focusedQuery.error : null);
  const errorMessage = viewError
    ? viewError instanceof Error
      ? viewError.message
      : t('usageAnalytics.loadFailed')
    : null;
  const loadingModel =
    focusModel !== undefined && !focusedMatches && !viewError
      ? focusModel
      : undefined;
  // A focused response adds a series, but must not reassign any existing color.
  const colors = useMemo(
    () =>
      overviewAnalytics
        ? getUsageModelColors(overviewAnalytics)
        : new Map<string, string>(),
    [overviewAnalytics]
  );
  const chartKeys = useMemo(
    () =>
      new Set(
        chartAnalytics
          ? getUsageChartSeries(chartAnalytics).map(series => series.key)
          : []
      ),
    [chartAnalytics]
  );
  const highlighted = preview ?? selected;
  const selectModel = (key?: string) => setSelectedModel(key);
  const chartKeyFor = (model: string | null): string | undefined => {
    if (!overviewAnalytics?.modelSeries?.length) return undefined;
    if (model === null && !overviewKeys.has('other')) return undefined;
    // Distinct model rows always have distinct interaction identities, even
    // while their on-demand series is loading. Only the actual remainder uses
    // the Other key.
    return usageModelKey(model);
  };
  const totals = analytics?.totals;
  const cards = useMemo(
    () => [
      {
        label: t('usageAnalytics.cards.calls'),
        value: formatCount(totals?.calls ?? 0),
        detail: t('usageAnalytics.cards.callsDetail', {
          count: totals?.uniqueUsers ?? 0,
        }),
        icon: Activity,
      },
      {
        label: t('usageAnalytics.cards.tokens'),
        value: formatCount(totals?.reportedTokens ?? 0),
        detail: t('usageAnalytics.cards.coverage', {
          percent: totals?.calls
            ? ((totals.meteredCalls / totals.calls) * 100).toFixed(1)
            : '0',
        }),
        icon: Gauge,
      },
      {
        label: t('usageAnalytics.cards.success'),
        value: `${successRate(
          totals?.calls ?? 0,
          (totals?.failedCalls ?? 0) + (totals?.cancelledCalls ?? 0)
        ).toFixed(1)}%`,
        detail: t('usageAnalytics.cards.successDetail', {
          count: totals?.failedCalls ?? 0,
        }),
        icon: CheckCircle2,
      },
      {
        label: t('usageAnalytics.cards.latency'),
        value: formatLatency(totals?.averageLatencyMs ?? 0),
        detail: t('usageAnalytics.cards.latencyDetail'),
        icon: Clock3,
      },
    ],
    [t, totals]
  );

  if (isLoading && !analytics) {
    return (
      <PageShell width='wide'>
        <div className='flex min-h-[50vh] items-center justify-center'>
          <Loader2 className='h-7 w-7 motion-safe:animate-spin text-primary-500' />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell width='wide'>
      <PageHeader
        eyebrow={t('usageAnalytics.eyebrow')}
        title={t('usageAnalytics.title')}
        description={t('usageAnalytics.description')}
        actions={
          <div className='flex items-center gap-2'>
            <div className='inline-flex rounded-xl border border-gray-200 bg-white/70 p-1 dark:border-white/[0.08] dark:bg-dark-100/70'>
              {[7, 30, 90].map(option => (
                <button
                  key={option}
                  type='button'
                  className={cn(
                    'min-h-9 rounded-lg px-3 py-1.5 text-xs font-medium motion-safe:transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500',
                    days === option
                      ? 'bg-gray-950 text-white dark:bg-white dark:text-gray-950'
                      : 'text-gray-500 hover:text-gray-900 dark:text-dark-500 dark:hover:text-dark-900'
                  )}
                  aria-pressed={days === option}
                  onClick={() => {
                    setDays(option);
                    setPreviewModel(undefined);
                  }}
                >
                  {t('usageAnalytics.days', { count: option })}
                </button>
              ))}
            </div>
            <Button
              variant='outline'
              size='sm'
              onClick={() => {
                void refetch();
                if (focusModel !== undefined) void focusedQuery.refetch();
              }}
              disabled={
                isFetching ||
                (focusModel !== undefined && focusedQuery.isFetching)
              }
            >
              <RefreshCw
                className={cn(
                  'h-4 w-4',
                  isFetching && 'motion-safe:animate-spin'
                )}
              />
              <span className='sr-only'>{t('usageAnalytics.refresh')}</span>
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

      <div className='mb-6'>
        <CostGovernancePanel days={days} />
      </div>

      {analytics && (
        <div className='min-w-0 space-y-4'>
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

          {analytics.heatmap && analytics.heatmap.cells.length > 0 && (
            <UsageHeatmap
              heatmap={analytics.heatmap}
              colors={colors}
              focusedModel={
                highlighted?.startsWith('model:')
                  ? highlighted.slice('model:'.length)
                  : undefined
              }
              chartModels={(overviewAnalytics?.modelSeries ?? []).flatMap(
                series => (series.model === null ? [] : [series.model])
              )}
            />
          )}

          <UsageChart
            analytics={chartAnalytics ?? analytics}
            metric={metric}
            onMetricChange={setMetric}
            colors={colors}
            highlighted={highlighted}
            selected={selected}
            onHighlight={setPreviewModel}
            onSelect={selectModel}
            loadingModel={loadingModel}
            canLoadModels={canLoadModels}
          />

          {analytics.totals.calls === 0 ? (
            <div className='rounded-2xl border border-dashed border-gray-300 px-6 py-10 text-center dark:border-white/[0.12]'>
              <Bot className='mx-auto h-8 w-8 text-gray-400 dark:text-dark-500' />
              <h2 className='mt-4 text-base font-medium text-gray-900 dark:text-dark-900'>
                {t('usageAnalytics.empty.title')}
              </h2>
              <p className='mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500 dark:text-dark-500'>
                {t('usageAnalytics.empty.description')}
              </p>
            </div>
          ) : (
            <div className='grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]'>
              <section className='min-w-0 overflow-hidden rounded-2xl border border-gray-200/80 bg-white/80 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/75'>
                <div className='border-b border-gray-200/70 px-4 py-3 dark:border-white/[0.07] sm:px-5'>
                  <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
                    {t('usageAnalytics.models.title')}
                  </h2>
                  <p className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
                    {t('usageAnalytics.models.description')}
                  </p>
                </div>
                <div className='overflow-x-auto'>
                  <table
                    data-testid='usage-model-table'
                    className='w-full min-w-[620px] text-start text-sm'
                  >
                    <thead className='text-[11px] uppercase tracking-[0.1em] text-gray-400 dark:text-dark-500'>
                      <tr>
                        <th className='px-5 py-2 text-start font-medium'>
                          {t('usageAnalytics.models.model')}
                        </th>
                        <th className='px-4 py-2 text-end font-medium'>
                          {t('usageAnalytics.metrics.calls')}
                        </th>
                        <th className='px-4 py-2 text-end font-medium'>
                          {t('usageAnalytics.metrics.tokens')}
                        </th>
                        <th className='px-4 py-2 text-end font-medium'>
                          {t('usageAnalytics.models.success')}
                        </th>
                        <th className='px-5 py-2 text-end font-medium'>
                          {t('usageAnalytics.models.latency')}
                        </th>
                      </tr>
                    </thead>
                    <tbody className='divide-y divide-gray-100 dark:divide-white/[0.06]'>
                      {analytics.models.map(model => (
                        <tr
                          key={JSON.stringify([
                            model.pluginId,
                            model.pluginName,
                            model.model,
                          ])}
                          data-testid='usage-model-row'
                          data-model={model.model}
                          data-highlighted={
                            highlighted === chartKeyFor(model.model)
                          }
                          onMouseEnter={() =>
                            setPreviewModel(chartKeyFor(model.model))
                          }
                          onMouseLeave={() => setPreviewModel(undefined)}
                          className={cn(
                            highlighted === chartKeyFor(model.model) &&
                              highlighted &&
                              'bg-gray-50 dark:bg-dark-200/70'
                          )}
                        >
                          <td className='px-5 py-2.5'>
                            <button
                              type='button'
                              disabled={!chartKeyFor(model.model)}
                              aria-label={t(
                                'usageAnalytics.activity.highlightModel',
                                { model: model.model }
                              )}
                              aria-pressed={
                                !!selected &&
                                selected === chartKeyFor(model.model)
                              }
                              className='flex min-h-9 max-w-[260px] items-center gap-2 rounded-md text-start font-medium text-gray-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500 dark:text-dark-900'
                              title={
                                chartKeys.has(usageModelKey(model.model))
                                  ? model.model
                                  : t('usageAnalytics.models.notCharted')
                              }
                              onFocus={() =>
                                setPreviewModel(chartKeyFor(model.model))
                              }
                              onBlur={() => setPreviewModel(undefined)}
                              onClick={() =>
                                selectModel(
                                  selected === chartKeyFor(model.model)
                                    ? undefined
                                    : chartKeyFor(model.model)
                                )
                              }
                            >
                              <span
                                aria-hidden='true'
                                className='h-2.5 w-2.5 shrink-0 rounded-full'
                                style={{
                                  backgroundColor:
                                    colors.get(usageModelKey(model.model)) ??
                                    OTHER_MODEL_COLOR,
                                }}
                              />
                              <span className='truncate' dir='ltr'>
                                {model.model}
                              </span>
                            </button>
                            <div className='mt-0.5 text-xs text-gray-500 dark:text-dark-500'>
                              {model.pluginName}
                            </div>
                          </td>
                          <td className='px-4 py-2.5 text-end tabular-nums text-gray-700 dark:text-dark-700'>
                            {formatCount(model.calls)}
                            <div
                              className='mt-1 text-[11px] text-gray-500 dark:text-dark-500'
                              title={t('usageAnalytics.models.share')}
                            >
                              {(
                                (model.calls / analytics.totals.calls) *
                                100
                              ).toFixed(1)}
                              %
                            </div>
                          </td>
                          <td className='px-4 py-2.5 text-end tabular-nums text-gray-700 dark:text-dark-700'>
                            {model.tokens ? formatCount(model.tokens) : '—'}
                          </td>
                          <td className='px-4 py-2.5 text-end tabular-nums text-gray-700 dark:text-dark-700'>
                            {successRate(model.calls, model.errors).toFixed(1)}%
                          </td>
                          <td className='px-5 py-2.5 text-end tabular-nums text-gray-500 dark:text-dark-500'>
                            {formatLatency(model.averageLatencyMs)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <div className='min-w-0 space-y-4'>
                <section
                  data-testid='usage-provider-breakdown'
                  className='min-w-0 rounded-2xl border border-gray-200/80 bg-white/80 p-4 shadow-subtle dark:border-white/[0.08] dark:bg-dark-100/75 sm:p-5'
                >
                  <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
                    {t('usageAnalytics.providers.title')}
                  </h2>
                  <p className='mt-1 text-xs leading-5 text-gray-500 dark:text-dark-500'>
                    {t('usageAnalytics.providers.description')}
                  </p>
                  <div className='mt-4 divide-y divide-gray-200/70 dark:divide-white/[0.07]'>
                    {analytics.plugins.map(plugin => {
                      const share = analytics.totals.calls
                        ? (plugin.calls / analytics.totals.calls) * 100
                        : 0;
                      const segments = getProviderModelSegments(
                        analytics,
                        plugin.pluginId,
                        plugin.calls,
                        plugin.pluginName
                      );
                      return (
                        <article
                          key={JSON.stringify([
                            plugin.pluginId,
                            plugin.pluginName,
                          ])}
                          data-provider={plugin.pluginId}
                          className='py-4 first:pt-0 last:pb-0'
                        >
                          <div className='flex items-start justify-between gap-3'>
                            <div className='min-w-0'>
                              <h3
                                className='truncate text-sm font-medium text-gray-900 dark:text-dark-900'
                                title={plugin.pluginName}
                              >
                                {plugin.pluginName}
                              </h3>
                              <p className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
                                {t('usageAnalytics.providers.share', {
                                  percent: share.toFixed(1),
                                })}
                              </p>
                            </div>
                            <div className='shrink-0 text-end'>
                              <div className='text-base font-medium tabular-nums text-gray-950 dark:text-dark-950'>
                                {formatCount(plugin.calls)}
                              </div>
                              <div className='text-[11px] text-gray-500 dark:text-dark-500'>
                                {t('usageAnalytics.metrics.calls')}
                              </div>
                            </div>
                          </div>
                          <div
                            className='my-3 flex h-2 overflow-hidden rounded-full bg-gray-100 dark:bg-dark-300'
                            aria-hidden='true'
                          >
                            {segments.map(segment => (
                              <span
                                key={usageModelKey(segment.model)}
                                data-model={segment.model ?? '__other__'}
                                title={`${segment.model ?? t('usageAnalytics.heatmap.other')}: ${formatCount(segment.calls)}`}
                                style={{
                                  width: `${plugin.calls ? (segment.calls / plugin.calls) * 100 : 0}%`,
                                  backgroundColor:
                                    colors.get(usageModelKey(segment.model)) ??
                                    OTHER_MODEL_COLOR,
                                  opacity:
                                    highlighted &&
                                    highlighted !== chartKeyFor(segment.model)
                                      ? 0.25
                                      : 1,
                                }}
                              />
                            ))}
                          </div>
                          <dl className='grid grid-cols-3 gap-2'>
                            <div>
                              <dt className='text-[10px] text-gray-500 dark:text-dark-500'>
                                {t('usageAnalytics.metrics.tokens')}
                              </dt>
                              <dd
                                className='mt-1 text-xs tabular-nums text-gray-800 dark:text-dark-800'
                                title={
                                  plugin.tokens
                                    ? undefined
                                    : t('usageAnalytics.providers.noTokens')
                                }
                              >
                                {plugin.tokens
                                  ? formatCount(plugin.tokens)
                                  : '—'}
                              </dd>
                            </div>
                            <div>
                              <dt className='text-[10px] text-gray-500 dark:text-dark-500'>
                                {t('usageAnalytics.models.success')}
                              </dt>
                              <dd className='mt-1 text-xs tabular-nums text-gray-800 dark:text-dark-800'>
                                {successRate(
                                  plugin.calls,
                                  plugin.errors
                                ).toFixed(1)}
                                %
                              </dd>
                            </div>
                            <div>
                              <dt className='text-[10px] text-gray-500 dark:text-dark-500'>
                                {t('usageAnalytics.models.latency')}
                              </dt>
                              <dd className='mt-1 text-xs tabular-nums text-gray-800 dark:text-dark-800'>
                                {formatLatency(plugin.averageLatencyMs)}
                              </dd>
                            </div>
                          </dl>
                          {plugin.errors > 0 && (
                            <p className='mt-2 flex items-center gap-1 text-[11px] text-gray-500 dark:text-dark-500'>
                              <TriangleAlert className='h-3 w-3' />
                              {t('usageAnalytics.providers.failures', {
                                count: plugin.errors,
                              })}
                            </p>
                          )}
                          <div className='mt-3 flex flex-wrap gap-1.5'>
                            {segments.map(segment => {
                              const key = chartKeyFor(segment.model);
                              const label =
                                segment.model ??
                                t('usageAnalytics.heatmap.other');
                              return (
                                <button
                                  key={usageModelKey(segment.model)}
                                  type='button'
                                  disabled={!key}
                                  aria-label={t(
                                    'usageAnalytics.activity.highlightModel',
                                    { model: label }
                                  )}
                                  aria-pressed={!!selected && selected === key}
                                  title={label}
                                  onMouseEnter={() => setPreviewModel(key)}
                                  onMouseLeave={() =>
                                    setPreviewModel(undefined)
                                  }
                                  onFocus={() => setPreviewModel(key)}
                                  onBlur={() => setPreviewModel(undefined)}
                                  onClick={() =>
                                    selectModel(
                                      selected === key ? undefined : key
                                    )
                                  }
                                  className={cn(
                                    'flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] text-gray-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-dark-700',
                                    highlighted && highlighted === key
                                      ? 'border-gray-400 bg-gray-50 dark:border-dark-500 dark:bg-dark-200'
                                      : 'border-gray-200/70 dark:border-white/[0.07]'
                                  )}
                                >
                                  <span
                                    className='h-2 w-2 shrink-0 rounded-full'
                                    style={{
                                      backgroundColor:
                                        colors.get(
                                          usageModelKey(segment.model)
                                        ) ?? OTHER_MODEL_COLOR,
                                    }}
                                    aria-hidden='true'
                                  />
                                  <span className='truncate' dir='auto'>
                                    {label}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>

                <section className='rounded-2xl border border-gray-200/80 bg-white/80 p-4 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/75 sm:p-5'>
                  <div className='flex items-center gap-2'>
                    <Users className='h-4 w-4 text-primary-500 dark:text-primary-400' />
                    <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
                      {t('usageAnalytics.capabilities.title')}
                    </h2>
                  </div>
                  <div className='mt-5 grid grid-cols-2 gap-3'>
                    {analytics.capabilities.map(capability => (
                      <div
                        key={capability.capability}
                        className='rounded-xl bg-gray-50 px-3 py-2.5 dark:bg-dark-200/70'
                      >
                        <div className='text-xs font-medium capitalize text-gray-500 dark:text-dark-500'>
                          {capability.capability}
                        </div>
                        <div className='mt-1 text-xl text-gray-950 dark:text-dark-950'>
                          {formatCount(capability.calls)}
                        </div>
                        <div className='mt-1 text-[11px] text-gray-500 dark:text-dark-500'>
                          {capability.capability === 'tts'
                            ? t('usageAnalytics.capabilities.characters', {
                                count: formatCount(capability.inputUnits),
                              })
                            : capability.capability === 'stt'
                              ? t('usageAnalytics.capabilities.bytes', {
                                  count: formatCount(capability.inputUnits),
                                })
                              : capability.capability === 'image'
                                ? t('usageAnalytics.capabilities.images', {
                                    count: formatCount(capability.outputUnits),
                                  })
                                : capability.capability === 'video'
                                  ? t('usageAnalytics.capabilities.jobs', {
                                      count: formatCount(capability.calls),
                                    })
                                  : capability.capability === 'embedding'
                                    ? t('usageAnalytics.capabilities.inputs', {
                                        count: formatCount(
                                          capability.inputUnits
                                        ),
                                      })
                                    : t(
                                        'usageAnalytics.capabilities.reportedTokens',
                                        {
                                          count: formatCount(capability.tokens),
                                        }
                                      )}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </div>
            </div>
          )}

          <p className='px-1 text-xs leading-5 text-gray-500 dark:text-dark-500'>
            {t('usageAnalytics.privacyNote')}
          </p>
        </div>
      )}
    </PageShell>
  );
};

export default PluginUsagePage;
