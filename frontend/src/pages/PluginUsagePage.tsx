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

import React, { useMemo, useState } from 'react';
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
import { pluginApi, type PluginUsageAnalytics } from '@/utils/api';
import { cn } from '@/utils';

type ChartMetric = 'calls' | 'tokens';

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

interface UsageChartProps {
  analytics: PluginUsageAnalytics;
  metric: ChartMetric;
  onMetricChange: (metric: ChartMetric) => void;
}

const UsageChart: React.FC<UsageChartProps> = ({
  analytics,
  metric,
  onMetricChange,
}) => {
  const { t } = useTranslation();
  const width = 960;
  const height = 280;
  const padding = { top: 22, right: 18, bottom: 42, left: 52 };
  const values = analytics.series.map(point => point[metric]);
  const maxValue = Math.max(1, ...values);
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xFor = (index: number): number =>
    padding.left +
    (analytics.series.length <= 1
      ? chartWidth / 2
      : (index / (analytics.series.length - 1)) * chartWidth);
  const yFor = (value: number): number =>
    padding.top + chartHeight - (value / maxValue) * chartHeight;
  const points = analytics.series.map((point, index) => ({
    x: xFor(index),
    y: yFor(point[metric]),
    point,
  }));
  const linePath = points
    .map(({ x, y }, index) => `${index === 0 ? 'M' : 'L'} ${x} ${y}`)
    .join(' ');
  const areaPath = points.length
    ? `${linePath} L ${points[points.length - 1].x} ${padding.top + chartHeight} L ${points[0].x} ${padding.top + chartHeight} Z`
    : '';
  const dateFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const labelIndexes = Array.from(
    new Set([
      0,
      Math.floor((analytics.series.length - 1) / 2),
      analytics.series.length - 1,
    ])
  ).filter(index => index >= 0);

  return (
    <div
      data-testid='plugin-usage-chart'
      className='overflow-hidden rounded-2xl border border-gray-200/80 bg-white/80 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/75'
    >
      <div className='flex flex-col gap-3 border-b border-gray-200/70 px-4 py-3 dark:border-white/[0.07] sm:flex-row sm:items-center sm:justify-between sm:px-5'>
        <div>
          <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
            {t('usageAnalytics.activity.title')}
          </h2>
          <p className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
            {metric === 'calls'
              ? t('usageAnalytics.activity.callsDescription')
              : t('usageAnalytics.activity.tokensDescription')}
          </p>
        </div>
        <div className='inline-flex w-fit rounded-xl bg-gray-100 p-1 dark:bg-dark-200/80'>
          {(['calls', 'tokens'] as const).map(option => (
            <button
              key={option}
              type='button'
              aria-pressed={metric === option}
              className={cn(
                'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                metric === option
                  ? 'bg-white text-gray-950 shadow-sm dark:bg-dark-300 dark:text-dark-950'
                  : 'text-gray-500 hover:text-gray-800 dark:text-dark-500 dark:hover:text-dark-800'
              )}
              onClick={() => onMetricChange(option)}
            >
              {t(`usageAnalytics.metrics.${option}`)}
            </button>
          ))}
        </div>
      </div>

      <div className='px-2 pb-3 pt-4 sm:px-5 sm:pt-6'>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className='h-auto w-full overflow-visible'
          role='img'
          aria-label={t('usageAnalytics.activity.chartLabel', {
            metric: t(`usageAnalytics.metrics.${metric}`),
          })}
        >
          <defs>
            <linearGradient id='plugin-usage-area' x1='0' y1='0' x2='0' y2='1'>
              <stop
                offset='0%'
                stopColor='rgb(var(--color-primary-500))'
                stopOpacity='0.28'
              />
              <stop
                offset='100%'
                stopColor='rgb(var(--color-primary-500))'
                stopOpacity='0.015'
              />
            </linearGradient>
          </defs>
          {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
            const y = padding.top + chartHeight * ratio;
            const value = Math.round(maxValue * (1 - ratio));
            return (
              <g key={ratio}>
                <line
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={y}
                  y2={y}
                  className='stroke-gray-200 dark:stroke-white/[0.07]'
                  strokeDasharray={ratio === 1 ? undefined : '4 8'}
                />
                <text
                  x={padding.left - 12}
                  y={y + 4}
                  textAnchor='end'
                  className='fill-gray-400 text-[11px] dark:fill-dark-500'
                >
                  {formatCount(value)}
                </text>
              </g>
            );
          })}
          {areaPath && <path d={areaPath} fill='url(#plugin-usage-area)' />}
          {linePath && (
            <path
              d={linePath}
              fill='none'
              className='stroke-primary-500 dark:stroke-primary-400'
              strokeWidth='3'
              strokeLinecap='round'
              strokeLinejoin='round'
            />
          )}
          {(analytics.series.length <= 31 ? points : []).map(
            ({ x, y, point }) => (
              <circle
                key={point.timestamp}
                cx={x}
                cy={y}
                r='4'
                className='fill-white stroke-primary-500 dark:fill-dark-100 dark:stroke-primary-400'
                strokeWidth='2.5'
              >
                <title>
                  {`${dateFormatter.format(point.timestamp)}: ${formatCount(point[metric])} ${t(`usageAnalytics.metrics.${metric}`).toLocaleLowerCase()}`}
                </title>
              </circle>
            )
          )}
          {labelIndexes.map(index => {
            const point = analytics.series[index];
            if (!point) return null;
            const anchor =
              index === 0
                ? 'start'
                : index === analytics.series.length - 1
                  ? 'end'
                  : 'middle';
            return (
              <text
                key={point.timestamp}
                x={xFor(index)}
                y={height - 10}
                textAnchor={anchor}
                className='fill-gray-500 text-[12px] dark:fill-dark-500'
              >
                {dateFormatter.format(point.timestamp)}
              </text>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CELL = 10;
const CELL_GAP = 2;
const CELL_PITCH = CELL + CELL_GAP;
const HEATMAP_LEFT_PAD = 30;
const HEATMAP_TOP_PAD = 16;

// Fixed categorical assignment, ranked by yearly calls. Light/dark steps were
// both run through the palette validator against the app surfaces.
const MODEL_FILLS = [
  'fill-blue-500',
  'fill-emerald-500 dark:fill-emerald-600',
  'fill-amber-500 dark:fill-amber-600',
  'fill-violet-500',
  'fill-rose-500',
];
const MODEL_CHIPS = [
  'bg-blue-500',
  'bg-emerald-500 dark:bg-emerald-600',
  'bg-amber-500 dark:bg-amber-600',
  'bg-violet-500',
  'bg-rose-500',
];
const OTHER_FILL = 'fill-gray-400 dark:fill-gray-500';
const OTHER_CHIP = 'bg-gray-400 dark:bg-gray-500';
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
}> = ({ heatmap }) => {
  const { t, i18n } = useTranslation();
  const [tooltip, setTooltip] = useState<HeatmapTooltip | null>(null);

  const { weeks, firstColStart, cellsByDay, maxCalls, modelRank, totalCalls } =
    useMemo(() => {
      const cellsByDay = new Map(
        heatmap.cells.map(cell => [cell.timestamp, cell])
      );
      const start = heatmap.from;
      const end = heatmap.from + (heatmap.days - 1) * DAY_MS;
      const firstColStart = start - new Date(start).getUTCDay() * DAY_MS;
      const weeks = Math.ceil((end - firstColStart + DAY_MS) / (7 * DAY_MS));
      const maxCalls = Math.max(1, ...heatmap.cells.map(cell => cell.calls));
      const modelRank = new Map(
        heatmap.models.map((model, index) => [model, index])
      );
      const totalCalls = heatmap.cells.reduce(
        (sum, cell) => sum + cell.calls,
        0
      );
      return {
        weeks,
        firstColStart,
        cellsByDay,
        maxCalls,
        modelRank,
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

  const fillFor = (cell: { models: Array<{ model: string }> }): string => {
    const top = cell.models[0]?.model;
    const rank = top !== undefined ? modelRank.get(top) : undefined;
    return rank !== undefined ? MODEL_FILLS[rank] : OTHER_FILL;
  };

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
      className='overflow-hidden rounded-2xl border border-gray-200/80 bg-white/80 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/75'
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
                    fillOpacity={level === 0 ? 1 : INTENSITY_OPACITY[level]}
                    strokeWidth={tooltip?.timestamp === timestamp ? 1 : 0}
                    className={cn(
                      'transition-opacity',
                      level === 0 || !cell ? EMPTY_FILL : fillFor(cell),
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
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-[3px]',
                      modelRank.has(entry.model)
                        ? MODEL_CHIPS[modelRank.get(entry.model) as number]
                        : OTHER_CHIP
                    )}
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
            {heatmap.models.map((model, index) => (
              <span
                key={model}
                className='flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-dark-600'
              >
                <span
                  className={cn(
                    'h-2.5 w-2.5 rounded-[3px]',
                    MODEL_CHIPS[index]
                  )}
                />
                <span className='font-mono' dir='ltr'>
                  {model}
                </span>
              </span>
            ))}
            <span className='flex items-center gap-1.5 text-[11px] text-gray-600 dark:text-dark-600'>
              <span className={cn('h-2.5 w-2.5 rounded-[3px]', OTHER_CHIP)} />
              {t('usageAnalytics.heatmap.other')}
            </span>
          </div>
          <div className='flex items-center gap-1.5 text-[11px] text-gray-500 dark:text-dark-500'>
            {t('usageAnalytics.heatmap.less')}
            <span className='h-2.5 w-2.5 rounded-[3px] bg-gray-950/[0.06] dark:bg-white/[0.07]' />
            {INTENSITY_OPACITY.slice(1).map(opacity => (
              <span
                key={opacity}
                className='h-2.5 w-2.5 rounded-[3px] bg-primary-500'
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
  const {
    data: analytics,
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
  const errorMessage = error
    ? error instanceof Error
      ? error.message
      : t('usageAnalytics.loadFailed')
    : null;

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
        detail: t('usageAnalytics.cards.tokensDetail', {
          count: totals?.meteredCalls ?? 0,
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
          <Loader2 className='h-7 w-7 animate-spin text-primary-500' />
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
                    'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
                    days === option
                      ? 'bg-gray-950 text-white dark:bg-white dark:text-gray-950'
                      : 'text-gray-500 hover:text-gray-900 dark:text-dark-500 dark:hover:text-dark-900'
                  )}
                  onClick={() => setDays(option)}
                >
                  {t('usageAnalytics.days', { count: option })}
                </button>
              ))}
            </div>
            <Button
              variant='outline'
              size='sm'
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              <RefreshCw
                className={cn('h-4 w-4', isFetching && 'animate-spin')}
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

      {analytics && (
        <div className='space-y-4'>
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
            <UsageHeatmap heatmap={analytics.heatmap} />
          )}

          <UsageChart
            analytics={analytics}
            metric={metric}
            onMetricChange={setMetric}
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
            <div className='grid gap-4 xl:grid-cols-[1.15fr_0.85fr]'>
              <section className='overflow-hidden rounded-2xl border border-gray-200/80 bg-white/80 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/75'>
                <div className='border-b border-gray-200/70 px-4 py-3 dark:border-white/[0.07] sm:px-5'>
                  <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
                    {t('usageAnalytics.models.title')}
                  </h2>
                  <p className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
                    {t('usageAnalytics.models.description')}
                  </p>
                </div>
                <div className='overflow-x-auto'>
                  <table className='w-full min-w-[620px] text-start text-sm'>
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
                      {analytics.models.slice(0, 12).map(model => (
                        <tr key={`${model.pluginId}:${model.model}`}>
                          <td className='px-5 py-2.5'>
                            <div
                              className='max-w-[260px] truncate font-medium text-gray-900 dark:text-dark-900'
                              title={model.model}
                            >
                              {model.model}
                            </div>
                            <div className='mt-0.5 text-xs text-gray-500 dark:text-dark-500'>
                              {model.pluginName}
                            </div>
                          </td>
                          <td className='px-4 py-2.5 text-end tabular-nums text-gray-700 dark:text-dark-700'>
                            {formatCount(model.calls)}
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

              <div className='space-y-4'>
                <section className='rounded-2xl border border-gray-200/80 bg-white/80 p-4 shadow-subtle backdrop-blur-md dark:border-white/[0.08] dark:bg-dark-100/75 sm:p-5'>
                  <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
                    {t('usageAnalytics.providers.title')}
                  </h2>
                  <div className='mt-5 space-y-4'>
                    {analytics.plugins.slice(0, 8).map(plugin => {
                      const share = analytics.totals.calls
                        ? (plugin.calls / analytics.totals.calls) * 100
                        : 0;
                      return (
                        <div key={plugin.pluginId}>
                          <div className='flex items-center justify-between gap-4 text-sm'>
                            <div className='min-w-0'>
                              <div className='truncate font-medium text-gray-900 dark:text-dark-900'>
                                {plugin.pluginName}
                              </div>
                              <div className='mt-0.5 text-xs text-gray-500 dark:text-dark-500'>
                                {formatCount(plugin.tokens)}{' '}
                                {t(
                                  'usageAnalytics.metrics.tokens'
                                ).toLocaleLowerCase()}
                              </div>
                            </div>
                            <span className='shrink-0 tabular-nums text-gray-600 dark:text-dark-600'>
                              {formatCount(plugin.calls)}
                            </span>
                          </div>
                          <div className='mt-2 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-dark-300'>
                            <div
                              className='h-full rounded-full bg-primary-500 dark:bg-primary-400'
                              style={{ width: `${Math.max(2, share)}%` }}
                            />
                          </div>
                        </div>
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
                                      count: formatCount(capability.inputUnits),
                                    })
                                  : t(
                                      'usageAnalytics.capabilities.reportedTokens',
                                      { count: formatCount(capability.tokens) }
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
