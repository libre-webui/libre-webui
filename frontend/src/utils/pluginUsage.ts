/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PluginUsageAnalytics } from './api/pluginApi';

// Categorical chart marks use the same colors on both themes. Labels and
// selection indicators also identify each model, independently of color.
const MODEL_COLORS = [
  '#3b82f6',
  '#059669',
  '#db683c',
  '#8b5cf6',
  '#e11d48',
  '#0891b2',
  '#a16207',
  '#db2777',
  '#0d9488',
  '#6366f1',
  '#65a30d',
  '#a855f7',
  '#4879a8',
  '#9d6c34',
  '#c25280',
  '#6f7d35',
  '#5363bb',
];
export const OTHER_MODEL_COLOR = '#6b7280';

const extendedModelColor = (index: number): string => {
  const hue = (index * 137.508) % 360;
  const rgbAt = (lightness: number): number[] => {
    const amplitude = 0.65 * Math.min(lightness, 1 - lightness);
    return [0, 8, 4].map(offset => {
      const position = (offset + hue / 30) % 12;
      return (
        lightness -
        amplitude * Math.max(-1, Math.min(position - 3, 9 - position, 1))
      );
    });
  };
  // Keep generated marks visible on both white and dark surfaces instead of
  // cycling the initial palette. Target relative luminance gives >=3:1 contrast
  // against both chart surfaces, including hues with naturally low luminance.
  let low = 0;
  let high = 1;
  for (let step = 0; step < 16; step++) {
    const midpoint = (low + high) / 2;
    const linear = rgbAt(midpoint).map(channel =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    );
    const luminance =
      linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
    if (luminance < 0.2) low = midpoint;
    else high = midpoint;
  }
  return `#${rgbAt((low + high) / 2)
    .map(channel =>
      Math.round(channel * 255)
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
};

export const usageModelKey = (model: string | null): string =>
  model === null ? 'other' : `model:${model}`;

export interface UsageChartSeries {
  key: string;
  model: string | null | undefined;
  points: PluginUsageAnalytics['series'];
}

export function matchesUsageSnapshot(
  overview: PluginUsageAnalytics,
  focused: PluginUsageAnalytics
): boolean {
  return (
    overview.range.from === focused.range.from &&
    overview.range.to === focused.range.to &&
    overview.series.length === focused.series.length &&
    overview.series.every((point, index) => {
      const other = focused.series[index];
      return (
        point.timestamp === other.timestamp &&
        point.calls === other.calls &&
        point.tokens === other.tokens &&
        point.errors === other.errors
      );
    })
  );
}

export function getUsageChartSeries(
  analytics: PluginUsageAnalytics
): UsageChartSeries[] {
  if (!analytics.modelSeries?.length) {
    // Older servers can only supply a total; never infer a daily model split
    // from the period's model totals or the calendar's truncated top models.
    return [{ key: 'total', model: undefined, points: analytics.series }];
  }
  return analytics.modelSeries.map(series => ({
    ...series,
    key: usageModelKey(series.model),
  }));
}

export function getUsageModelColors(
  analytics: PluginUsageAnalytics
): Map<string, string> {
  const annualModels = analytics.heatmap?.models ?? [];
  const chartModels = (analytics.modelSeries ?? [])
    .flatMap(series => (series.model === null ? [] : [series.model]))
    .filter(model => !annualModels.includes(model))
    .sort();
  const names = new Set([
    ...annualModels,
    ...(analytics.heatmap?.cells.flatMap(cell =>
      cell.models.map(entry => entry.model)
    ) ?? []),
    ...(analytics.modelSeries?.flatMap(series =>
      series.model === null ? [] : [series.model]
    ) ?? []),
    ...analytics.models.map(entry => entry.model),
  ]);
  const ordered = [
    ...annualModels,
    ...chartModels,
    ...[...names]
      .filter(
        name => !annualModels.includes(name) && !chartModels.includes(name)
      )
      .sort(),
  ];
  const colors = new Map<string, string>([
    ['other', OTHER_MODEL_COLOR],
    ['total', OTHER_MODEL_COLOR],
  ]);
  ordered.forEach((name, index) => {
    colors.set(
      usageModelKey(name),
      MODEL_COLORS[index] ?? extendedModelColor(index)
    );
  });
  return colors;
}

export function getProviderModelSegments(
  analytics: PluginUsageAnalytics,
  pluginId: string,
  calls: number,
  pluginName?: string
): Array<{ model: string | null; calls: number }> {
  const segments = analytics.models
    .filter(
      model =>
        model.pluginId === pluginId &&
        (pluginName === undefined || model.pluginName === pluginName) &&
        model.calls > 0
    )
    .map(({ model, calls }) => ({ model, calls }));
  const remainder =
    calls - segments.reduce((sum, entry) => sum + entry.calls, 0);
  return remainder > 0
    ? [...segments, { model: null, calls: remainder }]
    : segments;
}
