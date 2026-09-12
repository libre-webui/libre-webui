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

import assert from 'node:assert/strict';
import test from 'node:test';
import type { PluginUsageAnalytics } from './api/pluginApi';
import {
  getProviderModelSegments,
  getUsageChartSeries,
  getUsageModelColors,
  matchesUsageSnapshot,
  OTHER_MODEL_COLOR,
  usageModelKey,
} from './pluginUsage';

const from = Date.UTC(2026, 8, 10);
const to = from + 86_400_000;
const model = (
  name: string,
  pluginId: string,
  calls: number
): PluginUsageAnalytics['models'][number] => ({
  model: name,
  pluginId,
  pluginName: pluginId,
  calls,
  tokens: calls * 10,
  errors: 0,
  averageLatencyMs: 100,
});

const fixture = (): PluginUsageAnalytics => ({
  range: { from, to, days: 2 },
  totals: {
    calls: 5,
    successfulCalls: 5,
    failedCalls: 0,
    cancelledCalls: 0,
    meteredCalls: 5,
    promptTokens: 30,
    completionTokens: 20,
    reportedTokens: 50,
    averageLatencyMs: 100,
    uniqueUsers: 1,
  },
  series: [
    { timestamp: from, calls: 3, tokens: 30, errors: 0 },
    { timestamp: to, calls: 2, tokens: 20, errors: 0 },
  ],
  modelSeries: [
    {
      model: 'shared',
      points: [
        { timestamp: from, calls: 2, tokens: 20, errors: 0 },
        { timestamp: to, calls: 1, tokens: 10, errors: 0 },
      ],
    },
    {
      model: 'chart-only',
      points: [
        { timestamp: from, calls: 1, tokens: 10, errors: 0 },
        { timestamp: to, calls: 1, tokens: 10, errors: 0 },
      ],
    },
  ],
  plugins: [],
  models: [
    model('shared', 'provider-one', 2),
    model('shared', 'provider-two', 1),
    model('table-only', 'provider-one', 2),
  ],
  capabilities: [],
  heatmap: {
    from,
    days: 365,
    models: ['shared', 'annual-only'],
    cells: [
      {
        timestamp: from,
        calls: 3,
        models: [
          { model: 'shared', calls: 2 },
          { model: 'calendar-only', calls: 1 },
        ],
      },
      {
        timestamp: to,
        calls: 2,
        models: [
          { model: 'shared', calls: 1 },
          { model: 'table-only', calls: 1 },
        ],
      },
    ],
  },
});

test('only overlays focused history with matching time boundaries and daily totals', () => {
  const overview = fixture();
  assert.equal(matchesUsageSnapshot(overview, structuredClone(overview)), true);
  for (const boundary of ['from', 'to'] as const) {
    const changed = structuredClone(overview);
    changed.range[boundary] += 1;
    assert.equal(matchesUsageSnapshot(overview, changed), false);
  }
  for (const field of ['timestamp', 'calls', 'tokens', 'errors'] as const) {
    const changed = structuredClone(overview);
    changed.series[0][field] += 1;
    assert.equal(matchesUsageSnapshot(overview, changed), false, field);
  }
  const changed = structuredClone(overview);
  changed.series.pop();
  assert.equal(matchesUsageSnapshot(overview, changed), false);
});

for (const modelSeries of [undefined, []]) {
  test(`uses only aggregate points when modelSeries is ${modelSeries === undefined ? 'missing' : 'empty'}`, () => {
    const analytics = { ...fixture(), modelSeries };
    const series = getUsageChartSeries(analytics);
    assert.deepEqual(series, [
      { key: 'total', model: undefined, points: analytics.series },
    ]);
    assert.equal(series[0].points, analytics.series);
    assert.ok(analytics.models.length > 0);
    assert.ok(analytics.heatmap!.cells.length > 0);
  });
}

test('uses one raw model identity across providers, calendar, chart, and table', () => {
  const analytics = fixture();
  const colors = getUsageModelColors(analytics);
  const chartEntry = getUsageChartSeries(analytics).find(
    entry => entry.model === 'shared'
  )!;
  const sharedRows = analytics.models.filter(entry => entry.model === 'shared');
  const providerModels = ['provider-one', 'provider-two'].map(
    pluginId =>
      getProviderModelSegments(analytics, pluginId, 4).find(
        entry => entry.model === 'shared'
      )!.model
  );
  const surfaceKeys = [
    chartEntry.key,
    usageModelKey(analytics.heatmap!.models[0]),
    usageModelKey(analytics.heatmap!.cells[0].models[0].model),
    ...sharedRows.map(entry => usageModelKey(entry.model)),
    ...providerModels.map(usageModelKey),
  ];
  assert.equal(sharedRows.length, 2);
  assert.equal(new Set(surfaceKeys).size, 1);
  assert.notEqual(colors.get(chartEntry.key), undefined);
  assert.notEqual(colors.get(chartEntry.key), OTHER_MODEL_COLOR);
  for (const key of surfaceKeys) {
    assert.equal(colors.get(key), colors.get(chartEntry.key));
  }
  for (const name of [
    'annual-only',
    'calendar-only',
    'chart-only',
    'table-only',
  ]) {
    assert.notEqual(colors.get(usageModelKey(name)), undefined);
    assert.notEqual(colors.get(usageModelKey(name)), OTHER_MODEL_COLOR);
  }
});

test('keeps model colors stable when response arrays reorder with the annual ranking unchanged', () => {
  const analytics = fixture();
  const reordered: PluginUsageAnalytics = {
    ...analytics,
    models: [...analytics.models].reverse(),
    modelSeries: [...analytics.modelSeries!].reverse(),
    heatmap: {
      ...analytics.heatmap!,
      cells: [...analytics.heatmap!.cells]
        .reverse()
        .map(cell => ({ ...cell, models: [...cell.models].reverse() })),
    },
  };
  assert.deepEqual(
    getUsageModelColors(reordered),
    getUsageModelColors(analytics)
  );
});

test('keeps the null remainder and aggregate distinct from models literally named other or total', () => {
  const analytics = fixture();
  analytics.models = [
    model('other', 'provider-one', 2),
    model('total', 'provider-one', 2),
  ];
  analytics.modelSeries = [null, 'other', 'total'].map(name => ({
    model: name,
    points: analytics.series,
  }));
  const colors = getUsageModelColors(analytics);
  assert.deepEqual(
    getUsageChartSeries(analytics).map(entry => entry.key),
    ['other', 'model:other', 'model:total']
  );
  assert.equal(
    new Set([
      'total',
      usageModelKey(null),
      usageModelKey('other'),
      usageModelKey('total'),
    ]).size,
    4
  );
  assert.equal(colors.get(usageModelKey(null)), OTHER_MODEL_COLOR);
  assert.equal(colors.get('total'), OTHER_MODEL_COLOR);
  assert.notEqual(colors.get(usageModelKey('other')), OTHER_MODEL_COLOR);
  assert.notEqual(colors.get(usageModelKey('total')), OTHER_MODEL_COLOR);
});

test('provider segments preserve unlisted calls without borrowing another provider or zero-call rows', () => {
  const analytics = fixture();
  analytics.models.push(model('zero-calls', 'provider-one', 0));
  const segments = getProviderModelSegments(analytics, 'provider-one', 9);
  assert.deepEqual(segments, [
    { model: 'shared', calls: 2 },
    { model: 'table-only', calls: 2 },
    { model: null, calls: 5 },
  ]);
  assert.equal(
    segments.reduce((sum, entry) => sum + entry.calls, 0),
    9
  );
  assert.deepEqual(getProviderModelSegments(analytics, 'provider-two', 1), [
    { model: 'shared', calls: 1 },
  ]);
  assert.deepEqual(
    getProviderModelSegments(analytics, 'unlisted-provider', 3),
    [{ model: null, calls: 3 }]
  );
  assert.deepEqual(
    getProviderModelSegments(analytics, 'unlisted-provider', 0),
    []
  );
});

test('provider segments keep display-name snapshots separate after a rename', () => {
  const analytics = fixture();
  analytics.models = [
    { ...model('shared', 'provider-one', 8), pluginName: 'Previous name' },
    { ...model('shared', 'provider-one', 2), pluginName: 'Current name' },
  ];
  assert.deepEqual(
    getProviderModelSegments(analytics, 'provider-one', 10, 'Previous name'),
    [
      { model: 'shared', calls: 8 },
      { model: null, calls: 2 },
    ]
  );
  assert.deepEqual(
    getProviderModelSegments(analytics, 'provider-one', 2, 'Current name'),
    [{ model: 'shared', calls: 2 }]
  );
});

test('large model lists do not cycle identical colors and remain visible on both themes', () => {
  const analytics = fixture();
  analytics.models = Array.from({ length: 100 }, (_, index) =>
    model(`model-${String(index).padStart(3, '0')}`, 'provider-one', 1)
  );
  const colors = getUsageModelColors(analytics);
  const modelColors = analytics.models.map(entry =>
    colors.get(usageModelKey(entry.model))!
  );
  assert.equal(new Set(modelColors).size, 100);
  const luminance = (color: string) => {
    const channels = color
      .slice(1)
      .match(/../g)!
      .map(hex => {
        const channel = parseInt(hex, 16) / 255;
        return channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  };
  for (const color of modelColors) {
    assert.match(color, /^#[0-9a-f]{6}$/);
    const value = luminance(color);
    assert.ok(1.05 / (value + 0.05) >= 3, `${color} on white`);
    assert.ok(
      (value + 0.05) / (luminance('#171717') + 0.05) >= 3,
      `${color} on dark`
    );
  }
});
