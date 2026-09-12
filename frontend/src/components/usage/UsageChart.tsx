/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, RotateCcw } from 'lucide-react';
import type { PluginUsageAnalytics } from '@/utils/api';
import { cn } from '@/utils';
import { getUsageChartSeries, OTHER_MODEL_COLOR } from '@/utils/pluginUsage';

export type ChartMetric = 'calls' | 'tokens';

interface UsageChartProps {
  analytics: PluginUsageAnalytics;
  metric: ChartMetric;
  onMetricChange: (metric: ChartMetric) => void;
  colors: Map<string, string>;
  highlighted?: string;
  selected?: string;
  loadingModel?: string;
  canLoadModels?: boolean;
  onHighlight: (key?: string) => void;
  onSelect: (key?: string) => void;
}

export function UsageChart({
  analytics,
  metric,
  onMetricChange,
  colors,
  highlighted,
  selected,
  loadingModel,
  canLoadModels = false,
  onHighlight,
  onSelect,
}: UsageChartProps) {
  const { t, i18n } = useTranslation();
  const series = useMemo(() => getUsageChartSeries(analytics), [analytics]);
  const wrapper = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  const [exploredTimestamp, setExploredTimestamp] = useState<number>();
  useEffect(() => {
    const element = wrapper.current;
    if (!element) return;
    const observer = new ResizeObserver(entries => {
      setWidth(Math.max(280, entries[0].contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const count = (value: number, compact = false) =>
    new Intl.NumberFormat(i18n.language, {
      notation: compact && value >= 10_000 ? 'compact' : 'standard',
      maximumFractionDigits: compact ? 1 : 0,
    }).format(value);
  const date = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const name = (model: string | null | undefined): string =>
    model === undefined
      ? t('usageAnalytics.activity.allModels')
      : model === null
        ? t('usageAnalytics.heatmap.other')
        : model || '—';
  const height = 260;
  const padding = { top: 18, right: 20, bottom: 32, left: 48 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const peakValue = Math.max(
    1,
    ...series.flatMap(entry => entry.points.map(point => point[metric]))
  );
  const maxValue = Math.ceil(peakValue / 4) * 4;
  const total = analytics.series.reduce((sum, point) => sum + point[metric], 0);
  const noTokens = metric === 'tokens' && total === 0;
  const xFor = (index: number) =>
    padding.left +
    (analytics.series.length <= 1
      ? chartWidth / 2
      : (index / (analytics.series.length - 1)) * chartWidth);
  const yFor = (value: number) =>
    padding.top + chartHeight - (value / maxValue) * chartHeight;
  const requestedIndex = analytics.series.findIndex(
    point => point.timestamp === exploredTimestamp
  );
  const dayIndex =
    requestedIndex < 0
      ? Math.max(0, analytics.series.length - 1)
      : requestedIndex;
  const activeDay = analytics.series[dayIndex];
  const highlightedSeries = series.find(entry => entry.key === highlighted);
  const labels = [
    ...new Set([
      0,
      Math.floor((analytics.series.length - 1) / 2),
      analytics.series.length - 1,
    ]),
  ].filter(index => index >= 0);
  const dayRows = series
    .map(entry => ({ ...entry, value: entry.points[dayIndex]?.[metric] ?? 0 }))
    .sort((a, b) => b.value - a.value);
  const pathFor = (points: PluginUsageAnalytics['series']) =>
    points
      .map(
        (point, index) =>
          `${index === 0 ? 'M' : 'L'} ${xFor(index)} ${yFor(point[metric])}`
      )
      .join(' ');

  return (
    <section
      data-testid='plugin-usage-chart'
      aria-busy={loadingModel !== undefined}
      className='min-w-0 overflow-hidden rounded-2xl border border-gray-200/80 bg-white/80 shadow-subtle dark:border-white/[0.08] dark:bg-dark-100/75'
    >
      <div className='flex flex-wrap items-start justify-between gap-3 border-b border-gray-200/70 px-4 py-4 dark:border-white/[0.07] sm:px-5'>
        <div>
          <h2 className='text-sm font-medium text-gray-950 dark:text-dark-950'>
            {t('usageAnalytics.activity.title')}
          </h2>
          <p className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
            {t(
              `usageAnalytics.activity.${metric === 'calls' ? 'callsDescription' : 'tokensDescription'}`
            )}
          </p>
        </div>
        <div className='inline-flex rounded-xl bg-gray-100 p-1 dark:bg-dark-200/80'>
          {(['calls', 'tokens'] as const).map(option => (
            <button
              key={option}
              type='button'
              aria-pressed={metric === option}
              className={cn(
                'min-h-9 rounded-lg px-3 text-xs font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
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

      <div className='px-4 pt-4 sm:px-5'>
        <div className='mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2'>
          <p className='text-xs text-gray-500 dark:text-dark-500'>
            {t('usageAnalytics.activity.compareHint')}
          </p>
          <button
            type='button'
            disabled={!selected && !highlighted}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-gray-700 hover:bg-gray-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:text-dark-800 dark:hover:bg-dark-200',
              !selected && !highlighted && 'invisible'
            )}
            onClick={() => {
              onSelect(undefined);
              onHighlight(undefined);
            }}
          >
            <RotateCcw className='h-3.5 w-3.5' />
            {t('usageAnalytics.activity.showAll')}
          </button>
        </div>
        <div
          data-testid='usage-model-legend'
          className={cn(
            'grid gap-2 sm:grid-cols-2 lg:grid-cols-3',
            canLoadModels && 'h-48 content-start overflow-y-auto pe-1'
          )}
        >
          {series.map(entry => {
            const active = highlighted === entry.key;
            const pinned = selected === entry.key;
            const color = colors.get(entry.key) ?? OTHER_MODEL_COLOR;
            const value = entry.points.reduce(
              (sum, point) => sum + point[metric],
              0
            );
            return (
              <button
                key={entry.key}
                type='button'
                aria-pressed={pinned}
                aria-label={name(entry.model)}
                title={name(entry.model)}
                onMouseEnter={() => onHighlight(entry.key)}
                onMouseLeave={() => onHighlight(undefined)}
                onFocus={() => onHighlight(entry.key)}
                onBlur={() => onHighlight(undefined)}
                onClick={() => onSelect(pinned ? undefined : entry.key)}
                className={cn(
                  'flex min-h-11 min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-start focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-500',
                  active
                    ? 'border-gray-400 bg-gray-50 dark:border-dark-500 dark:bg-dark-200'
                    : 'border-gray-200/70 hover:bg-gray-50 dark:border-white/[0.07] dark:hover:bg-dark-200/70'
                )}
              >
                <span
                  className='h-2.5 w-2.5 shrink-0 rounded-full'
                  style={{ backgroundColor: color }}
                  aria-hidden='true'
                />
                <span
                  className='min-w-0 flex-1 truncate text-xs font-medium text-gray-800 dark:text-dark-900'
                  dir='auto'
                >
                  {name(entry.model)}
                </span>
                <span className='shrink-0 text-xs tabular-nums text-gray-500 dark:text-dark-500'>
                  {count(value, true)}
                </span>
                {pinned && (
                  <Check
                    className='h-3.5 w-3.5 shrink-0 text-gray-800 dark:text-dark-900'
                    aria-hidden='true'
                  />
                )}
              </button>
            );
          })}
        </div>
        {(canLoadModels || series.some(entry => entry.model === null)) && (
          <p className='mt-2 text-[11px] text-gray-500 dark:text-dark-500'>
            {t('usageAnalytics.activity.topModels')}
          </p>
        )}
        {series[0]?.model === undefined && (
          <p className='mt-2 text-xs text-gray-500 dark:text-dark-500'>
            {t('usageAnalytics.activity.breakdownUnavailable')}
          </p>
        )}
      </div>

      <div className='relative mx-3 mt-4 sm:mx-5' ref={wrapper}>
        {noTokens ? (
          <div className='flex h-[260px] items-center justify-center text-sm text-gray-500 dark:text-dark-500'>
            {t('usageAnalytics.activity.noTokens')}
          </div>
        ) : (
          <svg
            viewBox={`0 0 ${width} ${height}`}
            direction='ltr'
            className='block h-[260px] w-full touch-pan-y'
            role='img'
            aria-label={t('usageAnalytics.activity.chartLabel', {
              metric: t(`usageAnalytics.metrics.${metric}`),
            })}
            onPointerMove={event => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const x = ((event.clientX - bounds.left) * width) / bounds.width;
              const index = Math.round(
                Math.max(0, Math.min(1, (x - padding.left) / chartWidth)) *
                  (analytics.series.length - 1)
              );
              if (analytics.series[index])
                setExploredTimestamp(analytics.series[index].timestamp);
            }}
          >
            <title>
              {t('usageAnalytics.activity.chartLabel', {
                metric: t(`usageAnalytics.metrics.${metric}`),
              })}
            </title>
            {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
              const y = padding.top + chartHeight * ratio;
              return (
                <g key={ratio}>
                  <line
                    x1={padding.left}
                    x2={width - padding.right}
                    y1={y}
                    y2={y}
                    className='stroke-gray-200 dark:stroke-white/[0.07]'
                    strokeDasharray={ratio === 1 ? undefined : '3 6'}
                  />
                  <text
                    x={padding.left - 9}
                    y={y + 4}
                    textAnchor='end'
                    className='fill-gray-500 text-[11px] dark:fill-dark-500'
                  >
                    {count(Math.round(maxValue * (1 - ratio)), true)}
                  </text>
                </g>
              );
            })}
            {activeDay && (
              <line
                x1={xFor(dayIndex)}
                x2={xFor(dayIndex)}
                y1={padding.top}
                y2={height - padding.bottom}
                className='stroke-gray-300 dark:stroke-dark-400'
                strokeDasharray='3 4'
              />
            )}
            {[...series]
              .sort(
                (a, b) =>
                  Number(a.key === highlighted) - Number(b.key === highlighted)
              )
              .map(entry => {
                const active = entry.key === highlighted;
                const color = colors.get(entry.key) ?? OTHER_MODEL_COLOR;
                const lastPoint = entry.points[dayIndex];
                return (
                  <g
                    key={entry.key}
                    opacity={highlighted && !active ? 0.18 : 1}
                  >
                    <path
                      data-testid='usage-model-line'
                      data-model={
                        entry.model === undefined
                          ? '__total__'
                          : (entry.model ?? '__other__')
                      }
                      data-highlighted={active}
                      d={pathFor(entry.points)}
                      stroke={color}
                      fill='none'
                      strokeWidth={active ? 3.5 : 2}
                      strokeDasharray={entry.model === null ? '6 4' : undefined}
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      vectorEffect='non-scaling-stroke'
                    >
                      <title>{name(entry.model)}</title>
                    </path>
                    {lastPoint && (
                      <circle
                        cx={xFor(dayIndex)}
                        cy={yFor(lastPoint[metric])}
                        r={active ? 5 : 3.5}
                        fill={color}
                        className='stroke-white dark:stroke-dark-100'
                        strokeWidth='2'
                      />
                    )}
                  </g>
                );
              })}
            {labels.map(index => (
              <text
                key={index}
                x={xFor(index)}
                y={height - 8}
                textAnchor={
                  index === 0
                    ? 'start'
                    : index === analytics.series.length - 1
                      ? 'end'
                      : 'middle'
                }
                className='fill-gray-500 text-[11px] dark:fill-dark-500'
              >
                {date.format(analytics.series[index].timestamp)}
              </text>
            ))}
          </svg>
        )}
      </div>

      {activeDay && (
        <div className='border-t border-gray-200/70 px-4 py-4 dark:border-white/[0.07] sm:px-5'>
          <label className='mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-dark-500'>
            <span>{t('usageAnalytics.activity.exploreDay')}</span>
            <span className='text-gray-800 dark:text-dark-800'>
              {date.format(activeDay.timestamp)}
            </span>
            <input
              data-testid='usage-chart-day-slider'
              type='range'
              min={0}
              max={Math.max(0, analytics.series.length - 1)}
              step={1}
              value={dayIndex}
              aria-label={t('usageAnalytics.activity.exploreDay')}
              aria-valuetext={date.format(activeDay.timestamp)}
              onChange={event =>
                setExploredTimestamp(
                  analytics.series[Number(event.target.value)]?.timestamp
                )
              }
              className='h-6 w-full cursor-pointer accent-gray-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-500 dark:accent-gray-300'
              dir='ltr'
            />
          </label>
          <div
            data-testid='usage-chart-day-detail'
            aria-live='polite'
            aria-atomic='true'
          >
            <div className='mb-3 flex flex-wrap items-baseline justify-between gap-2'>
              <span className='text-xs font-medium text-gray-700 dark:text-dark-800'>
                {t('usageAnalytics.activity.dayTotal')} ·{' '}
                {date.format(activeDay.timestamp)}
              </span>
              <span className='text-sm font-medium tabular-nums text-gray-950 dark:text-dark-950'>
                {count(activeDay[metric])}{' '}
                {t(`usageAnalytics.metrics.${metric}`)}
              </span>
            </div>
            <div
              className={cn(
                'grid gap-x-5 gap-y-2 sm:grid-cols-2 lg:grid-cols-3',
                canLoadModels && 'max-h-40 overflow-y-auto'
              )}
            >
              {dayRows.map(entry => (
                <div
                  key={entry.key}
                  data-model={
                    entry.model === undefined
                      ? '__total__'
                      : (entry.model ?? '__other__')
                  }
                  className={cn(
                    'flex min-w-0 items-center gap-2 text-xs',
                    highlighted === entry.key && 'font-medium'
                  )}
                >
                  <span
                    aria-hidden='true'
                    className='h-2 w-2 shrink-0 rounded-full'
                    style={{
                      backgroundColor:
                        colors.get(entry.key) ?? OTHER_MODEL_COLOR,
                    }}
                  />
                  <span
                    className='min-w-0 flex-1 truncate text-gray-600 dark:text-dark-700'
                    title={name(entry.model)}
                    dir='auto'
                  >
                    {name(entry.model)}
                  </span>
                  <span className='shrink-0 tabular-nums text-gray-900 dark:text-dark-900'>
                    {count(entry.value)}
                  </span>
                </div>
              ))}
            </div>
            <p className='mt-3 h-4 truncate text-xs font-medium text-gray-600 dark:text-dark-700'>
              {loadingModel !== undefined
                ? t('usageAnalytics.activity.loadingModel', {
                    model: loadingModel,
                  })
                : highlightedSeries
                  ? t('usageAnalytics.activity.highlightedModel', {
                      model: name(highlightedSeries.model),
                    })
                  : t('usageAnalytics.activity.allModels')}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}
