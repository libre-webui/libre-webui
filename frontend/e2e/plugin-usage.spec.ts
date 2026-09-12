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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';
import type { PluginUsageAnalytics } from '../src/utils/api/pluginApi';

const systemInfo = {
  requiresAuth: true,
  hasUsers: true,
  userCount: 2,
  signupEnabled: true,
  // The Agents entry only exists when an administrator enabled the feature.
  agentsEnabled: true,
  version: '0.17.0-e2e',
  turnstile: { enabled: false },
};

const now = Date.now();
const day = 86_400_000;
const today = Math.floor(now / day) * day;
const gptModel = 'gpt-5.1';
const claudeModel = 'claude-sonnet-4.5';

const modelUsageFixture = (reportTokens = true): PluginUsageAnalytics => {
  const modelSeries = [
    {
      model: gptModel,
      points: Array.from({ length: 30 }, (_, index) => ({
        timestamp: today - (29 - index) * day,
        calls: index % 3 === 0 ? 6 : 2,
        tokens: reportTokens ? ((index % 5) + 1) * 170 : 0,
        errors: index === 10 ? 1 : 0,
      })),
    },
    {
      model: claudeModel,
      points: Array.from({ length: 30 }, (_, index) => ({
        timestamp: today - (29 - index) * day,
        calls: index % 4 === 0 ? 1 : 5,
        tokens: reportTokens ? ((index % 7) + 1) * 310 : 0,
        errors: index === 15 ? 1 : 0,
      })),
    },
    {
      model: null,
      points: Array.from({ length: 30 }, (_, index) => ({
        timestamp: today - (29 - index) * day,
        calls: index === 28 ? 3 : 0,
        tokens: reportTokens && index === 28 ? 90 : 0,
        errors: 0,
      })),
    },
  ];
  const series = modelSeries[0].points.map((point, index) => ({
    timestamp: point.timestamp,
    calls: modelSeries.reduce(
      (sum, model) => sum + model.points[index].calls,
      0
    ),
    tokens: modelSeries.reduce(
      (sum, model) => sum + model.points[index].tokens,
      0
    ),
    errors: modelSeries.reduce(
      (sum, model) => sum + model.points[index].errors,
      0
    ),
  }));
  const totalsFor = (index: number) => ({
    calls: modelSeries[index].points.reduce(
      (sum, point) => sum + point.calls,
      0
    ),
    tokens: modelSeries[index].points.reduce(
      (sum, point) => sum + point.tokens,
      0
    ),
    errors: modelSeries[index].points.reduce(
      (sum, point) => sum + point.errors,
      0
    ),
    averageLatencyMs: index === 0 ? 1580 : 2410,
  });
  const gptTotals = totalsFor(0);
  const claudeTotals = totalsFor(1);
  const otherTotals = totalsFor(2);
  const calls = series.reduce((sum, point) => sum + point.calls, 0);
  const reportedTokens = series.reduce((sum, point) => sum + point.tokens, 0);

  return {
    range: { from: series[0].timestamp, to: today + day - 1, days: 30 },
    totals: {
      calls,
      successfulCalls: calls - 2,
      failedCalls: 2,
      cancelledCalls: 0,
      meteredCalls: reportTokens ? calls : 0,
      promptTokens: reportedTokens,
      completionTokens: 0,
      reportedTokens,
      averageLatencyMs: 1840,
      uniqueUsers: 2,
    },
    series,
    modelSeries,
    plugins: [
      { pluginId: 'openai', pluginName: 'OpenAI', ...gptTotals },
      {
        pluginId: 'anthropic',
        pluginName: 'Anthropic',
        ...claudeTotals,
        calls: claudeTotals.calls + otherTotals.calls,
        tokens: claudeTotals.tokens + otherTotals.tokens,
      },
    ],
    models: [
      {
        model: gptModel,
        pluginId: 'openai',
        pluginName: 'OpenAI',
        ...gptTotals,
      },
      {
        model: claudeModel,
        pluginId: 'anthropic',
        pluginName: 'Anthropic',
        ...claudeTotals,
      },
      {
        model: 'claude-haiku-4.5',
        pluginId: 'anthropic',
        pluginName: 'Anthropic',
        ...otherTotals,
      },
    ],
    capabilities: [
      {
        capability: 'chat',
        calls,
        tokens: reportedTokens,
        inputUnits: 0,
        outputUnits: 0,
      },
    ],
    heatmap: {
      from: today - 364 * day,
      days: 365,
      // Yearly ranking differs from series order; identities must retain colors.
      models: [claudeModel, gptModel],
      cells: series.map((point, index) => ({
        timestamp: point.timestamp,
        calls: point.calls,
        models: modelSeries
          .map(model => ({
            model: model.model ?? 'claude-haiku-4.5',
            calls: model.points[index].calls,
          }))
          .filter(model => model.calls > 0)
          .sort((left, right) => right.calls - left.calls),
      })),
    },
  };
};

const outsideModel = 'vendor/model+13:preview';
const otherOutsideModel = 'vendor/model-14';

const manyModelUsageFixture = (focus?: string): PluginUsageAnalytics => {
  const allSeries = Array.from({ length: 14 }, (_, modelIndex) => ({
    model:
      modelIndex === 12
        ? outsideModel
        : modelIndex === 13
          ? otherOutsideModel
          : `model-${String(modelIndex + 1).padStart(2, '0')}`,
    points: Array.from({ length: 30 }, (_, index) => {
      const calls =
        modelIndex < 12
          ? 20 - modelIndex
          : modelIndex === 12
            ? 2 + (index % 2)
            : 1;
      return {
        timestamp: today - (29 - index) * day,
        calls,
        tokens: calls * 100 + modelIndex * 10,
        errors: 0,
      };
    }),
  }));
  const sumPoints = (entries: typeof allSeries) =>
    allSeries[0].points.map((point, index) => ({
      timestamp: point.timestamp,
      calls: entries.reduce((sum, entry) => sum + entry.points[index].calls, 0),
      tokens: entries.reduce(
        (sum, entry) => sum + entry.points[index].tokens,
        0
      ),
      errors: 0,
    }));
  const series = sumPoints(allSeries);
  const calls = series.reduce((sum, point) => sum + point.calls, 0);
  const tokens = series.reduce((sum, point) => sum + point.tokens, 0);
  const shown = allSeries.filter(
    (entry, index) => index < 12 || entry.model === focus
  );
  const remainder = allSeries.filter(entry => !shown.includes(entry));
  return {
    range: { from: series[0].timestamp, to: today + day - 1, days: 30 },
    totals: {
      calls,
      successfulCalls: calls,
      failedCalls: 0,
      cancelledCalls: 0,
      meteredCalls: calls,
      promptTokens: tokens,
      completionTokens: 0,
      reportedTokens: tokens,
      averageLatencyMs: 1000,
      uniqueUsers: 1,
    },
    series,
    modelSeries: [...shown, { model: null, points: sumPoints(remainder) }],
    models: allSeries.map(entry => ({
      model: entry.model,
      pluginId: 'model-gateway',
      pluginName: 'Model Gateway',
      calls: entry.points.reduce((sum, point) => sum + point.calls, 0),
      tokens: entry.points.reduce((sum, point) => sum + point.tokens, 0),
      errors: 0,
      averageLatencyMs: 1000,
    })),
    plugins: [
      {
        pluginId: 'model-gateway',
        pluginName: 'Model Gateway',
        calls,
        tokens,
        errors: 0,
        averageLatencyMs: 1000,
      },
    ],
    capabilities: [
      { capability: 'chat', calls, tokens, inputUnits: 0, outputUnits: 0 },
    ],
    heatmap: {
      from: today - 364 * day,
      days: 365,
      models: allSeries.slice(0, 5).map(entry => entry.model),
      cells: [
        {
          timestamp: today - 100 * day,
          calls: 3,
          models: [{ model: outsideModel, calls: 3 }],
        },
        ...series.map((point, index) => ({
          timestamp: point.timestamp,
          calls: point.calls,
          models: allSeries.slice(0, 5).map(entry => ({
            model: entry.model,
            calls: entry.points[index].calls,
          })),
        })),
      ],
    },
  };
};

async function openModelUsage(
  page: Page,
  usage = modelUsageFixture(),
  mode: 'light' | 'dark' = 'dark',
  language = 'en'
) {
  await mockLibreWebUiApi(page, {
    systemInfo,
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
        preferences: {
          theme: {
            mode,
            adaptToAccent: false,
            accent: 'blue',
            customAccent: '#2563eb',
          },
        },
      },
    ],
    pluginUsage: usage,
  });
  await page.addInitScript(locale => {
    localStorage.setItem('auth-token', 'admin-token');
    localStorage.setItem('i18nextLng', locale);
  }, language);
  await page.goto('/usage');
  await expect(page.getByTestId('plugin-usage-chart')).toBeVisible();
}

test('administrators open provider usage from the user menu', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo,
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
    pluginUsage: {
      range: { from: now - 29 * day, to: now, days: 30 },
      totals: {
        calls: 128,
        successfulCalls: 124,
        failedCalls: 4,
        cancelledCalls: 0,
        meteredCalls: 96,
        promptTokens: 910_000,
        completionTokens: 330_000,
        reportedTokens: 1_240_000,
        averageLatencyMs: 1840,
        uniqueUsers: 2,
      },
      series: Array.from({ length: 30 }, (_, index) => ({
        timestamp: now - (29 - index) * day,
        calls: index + 1,
        tokens: (index + 1) * 1200,
        errors: index === 18 ? 2 : 0,
      })),
      plugins: [
        {
          pluginId: 'openai',
          pluginName: 'OpenAI',
          calls: 88,
          tokens: 940_000,
          errors: 2,
          averageLatencyMs: 1580,
        },
        {
          pluginId: 'anthropic',
          pluginName: 'Anthropic',
          calls: 40,
          tokens: 300_000,
          errors: 2,
          averageLatencyMs: 2410,
        },
      ],
      models: [
        {
          model: 'gpt-5.1',
          pluginId: 'openai',
          pluginName: 'OpenAI',
          calls: 88,
          tokens: 940_000,
          errors: 2,
          averageLatencyMs: 1580,
        },
      ],
      capabilities: [
        {
          capability: 'chat',
          calls: 118,
          tokens: 1_240_000,
          inputUnits: 0,
          outputUnits: 0,
        },
        {
          capability: 'image',
          calls: 10,
          tokens: 0,
          inputUnits: 0,
          outputUnits: 16,
        },
      ],
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/');
  await page.getByTestId('app-tab-new').click();
  const newTabMenu = page.getByTestId('app-tab-new-menu');
  const newTabLabels = await newTabMenu.getByRole('menuitem').allTextContents();
  const agentsIndex = newTabLabels.findIndex(label => label.includes('Agents'));
  const systemIndex = newTabLabels.findIndex(label => label.includes('System'));
  const usageIndex = newTabLabels.findIndex(label =>
    label.includes('Provider Usage')
  );
  expect(agentsIndex).toBeGreaterThan(-1);
  expect(systemIndex).toBeGreaterThan(agentsIndex);
  expect(usageIndex).toBeGreaterThan(systemIndex);
  // User Management moved into Settings; it is no longer a page tab.
  expect(newTabLabels.some(label => label.includes('User Management'))).toBe(
    false
  );
  await page.getByTestId('app-tab-new').click();

  await page.getByRole('button', { name: /admin/i }).last().click();
  await expect(
    page.getByTestId('sidebar-user-menu').locator('button, a')
  ).toHaveText([
    'Change Picture',
    // Icon-only pin toggles follow each admin shortcut row.
    'System',
    '',
    'Provider Usage',
    '',
    'Evaluations',
    '',
    'Settings',
    'Log out',
  ]);
  await page.getByRole('link', { name: 'Provider Usage' }).click();

  await expect(page).toHaveURL(/\/usage$/);
  await expect(
    page.getByRole('heading', { name: 'Provider Usage' })
  ).toBeVisible();
  await expect(page.getByTestId('plugin-usage-chart')).toBeVisible();
  await expect(page.getByText('1.2M', { exact: true })).toBeVisible();
  await expect(
    page.getByTestId('usage-model-table').getByText('gpt-5.1', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('OpenAI').first()).toBeVisible();
});

test('regular users do not receive the provider usage navigation entry', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo,
    authUsers: [
      {
        id: 'regular-user',
        username: 'member',
        email: 'member@example.test',
        role: 'user',
        status: 'active',
        token: 'member-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'member-token');
  });

  await page.goto('/');
  await page
    .getByRole('button', { name: /member/i })
    .last()
    .click();
  await expect(page.getByRole('link', { name: 'Provider Usage' })).toHaveCount(
    0
  );

  await page.getByTestId('app-tab-new').click();
  const newTabMenu = page.getByTestId('app-tab-new-menu');
  await expect(
    newTabMenu.getByRole('menuitem', { name: 'User Management' })
  ).toHaveCount(0);
  await expect(
    newTabMenu.getByRole('menuitem', { name: 'System' })
  ).toHaveCount(0);
  await expect(
    newTabMenu.getByRole('menuitem', { name: 'Provider Usage' })
  ).toHaveCount(0);
});

test('model colors link the chart and heatmap while highlighting preserves totals', async ({
  page,
}) => {
  const usage = modelUsageFixture();
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openModelUsage(page, usage);

  const chart = page.getByTestId('plugin-usage-chart');
  const legend = page.getByTestId('usage-model-legend');
  const gptButton = legend.getByRole('button', { name: gptModel, exact: true });
  const claudeButton = legend.getByRole('button', {
    name: claudeModel,
    exact: true,
  });
  const gptLine = chart.locator(
    `[data-testid="usage-model-line"][data-model="${gptModel}"]`
  );
  const claudeLine = chart.locator(
    `[data-testid="usage-model-line"][data-model="${claudeModel}"]`
  );
  await expect(chart.getByTestId('usage-model-line')).toHaveCount(3);
  await expect(
    legend.getByRole('button', { name: 'Other models', exact: true })
  ).toBeVisible();
  const gptColor = await gptLine.getAttribute('stroke');
  const claudeColor = await claudeLine.getAttribute('stroke');
  expect(gptColor).toMatch(/^#[0-9a-f]{6}$/i);
  expect(claudeColor).toMatch(/^#[0-9a-f]{6}$/i);
  expect(gptColor).not.toBe(claudeColor);
  expect(await gptLine.getAttribute('d')).not.toBe(
    await claudeLine.getAttribute('d')
  );
  await expect(
    page
      .getByTestId('usage-heatmap')
      .locator(`rect[data-model="${gptModel}"]`)
      .first()
  ).toHaveAttribute('fill', gptColor!);
  await expect(
    page
      .getByTestId('usage-heatmap')
      .locator(`rect[data-model="${claudeModel}"]`)
      .first()
  ).toHaveAttribute('fill', claudeColor!);

  const table = page.getByTestId('usage-model-table');
  const providers = page.getByTestId('usage-provider-breakdown');
  const tableBefore = await table.innerText();
  const providersBefore = await providers.innerText();
  const gptRow = table.locator(
    `[data-testid="usage-model-row"][data-model="${gptModel}"]`
  );
  await expect(gptRow).toContainText('OpenAI');
  await expect(gptRow.getByRole('cell').nth(1)).toContainText(
    String(usage.models[0].calls)
  );
  const gptRgb = `rgb(${gptColor!
    .slice(1)
    .match(/../g)!
    .map(value => parseInt(value, 16))
    .join(', ')})`;
  await expect(gptRow.locator('span[aria-hidden="true"]')).toHaveCSS(
    'background-color',
    gptRgb
  );
  await expect(gptButton.locator('span[aria-hidden="true"]')).toHaveCSS(
    'background-color',
    gptRgb
  );
  await expect(providers.locator(`span[data-model="${gptModel}"]`)).toHaveCSS(
    'background-color',
    gptRgb
  );
  await expect(providers).toContainText('OpenAI');
  await expect(providers).toContainText('Anthropic');
  await chart.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/tmp/libre-usage-desktop.png' });

  await gptButton.hover();
  await expect(gptLine).toHaveAttribute('data-highlighted', 'true');
  await expect(claudeLine).toHaveAttribute('data-highlighted', 'false');
  await page.mouse.move(0, 0);
  await expect(gptLine).toHaveAttribute('data-highlighted', 'false');

  await claudeButton.focus();
  await expect(claudeLine).toHaveAttribute('data-highlighted', 'true');
  await chart.getByTestId('usage-chart-day-slider').focus();
  await expect(claudeLine).toHaveAttribute('data-highlighted', 'false');

  await gptButton.click();
  await chart.getByTestId('usage-chart-day-slider').focus();
  await page.mouse.move(0, 0);
  await expect(gptButton).toHaveAttribute('aria-pressed', 'true');
  await expect(gptLine).toHaveAttribute('data-highlighted', 'true');
  await claudeButton.hover();
  await expect(claudeLine).toHaveAttribute('data-highlighted', 'true');
  await page.mouse.move(0, 0);
  await expect(gptLine).toHaveAttribute('data-highlighted', 'true');
  await expect(claudeLine).toHaveAttribute('data-highlighted', 'false');

  await chart
    .getByRole('button', { name: 'Show all models', exact: true })
    .click();
  await expect(gptButton).toHaveAttribute('aria-pressed', 'false');
  await expect(gptLine).toHaveAttribute('data-highlighted', 'false');
  const claudeTableButton = table.getByRole('button', {
    name: `Highlight ${claudeModel}`,
    exact: true,
  });
  await claudeTableButton.click();
  await expect(claudeTableButton).toHaveAttribute('aria-pressed', 'true');
  await chart.getByTestId('usage-chart-day-slider').focus();
  await page.mouse.move(0, 0);
  await expect(claudeLine).toHaveAttribute('data-highlighted', 'true');
  expect(await table.innerText()).toBe(tableBefore);
  expect(await providers.innerText()).toBe(providersBefore);
});

test('the daily explorer exposes per-model Calls and Tokens with keyboard navigation', async ({
  page,
}) => {
  await openModelUsage(page);
  const chart = page.getByTestId('plugin-usage-chart');
  const slider = chart.getByRole('slider', { name: 'Explore daily usage' });
  const detail = chart.getByTestId('usage-chart-day-detail');
  const gptDetail = detail.locator(`[data-model="${gptModel}"]`);
  const claudeDetail = detail.locator(`[data-model="${claudeModel}"]`);
  const gptLine = chart.locator(
    `[data-testid="usage-model-line"][data-model="${gptModel}"]`
  );
  await expect(slider).toHaveValue('29');
  await slider.focus();
  await slider.press('Home');
  await expect(slider).toHaveValue('0');
  await expect(gptDetail.locator('span').last()).toHaveText('6');
  await expect(claudeDetail.locator('span').last()).toHaveText('1');
  const firstDay = await detail.innerText();
  const callsPath = await gptLine.getAttribute('d');

  await slider.press('ArrowRight');
  await expect(slider).toHaveValue('1');
  await expect(gptDetail.locator('span').last()).toHaveText('2');
  await expect(claudeDetail.locator('span').last()).toHaveText('5');
  expect(await detail.innerText()).not.toBe(firstDay);
  await chart.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(
    chart.getByRole('button', { name: 'Tokens', exact: true })
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(gptDetail.locator('span').last()).toHaveText('340');
  await expect(claudeDetail.locator('span').last()).toHaveText('620');
  expect(await gptLine.getAttribute('d')).not.toBe(callsPath);
  await chart.getByRole('button', { name: 'Calls', exact: true }).click();
  await expect(gptLine).toHaveAttribute('d', callsPath!);
  await slider.focus();
  await slider.press('End');
  await expect(slider).toHaveValue('29');
});

test('models outside the busiest twelve load and highlight their own history independently', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const overview = manyModelUsageFixture();
  await openModelUsage(page, overview);
  const requestedModels: Array<{
    days: string | null;
    model: string | null;
    to: string | null;
  }> = [];
  let releaseFirstFocus = () => {};
  const firstFocusReady = new Promise<void>(resolve => {
    releaseFirstFocus = resolve;
  });
  await page.route(/\/api\/plugins\/usage(?:\?.*)?$/, async route => {
    expect(route.request().method()).toBe('GET');
    const url = new URL(route.request().url());
    const model = url.searchParams.get('model');
    requestedModels.push({
      days: url.searchParams.get('days'),
      model,
      to: url.searchParams.get('to'),
    });
    if (model === outsideModel) await firstFocusReady;
    const focused = manyModelUsageFixture(model ?? undefined);
    if (model) {
      // A focused detail response must never replace the frozen overview's
      // cards or model/provider inventory, even if its metadata has drifted.
      focused.totals.calls += 7;
      focused.totals.successfulCalls += 7;
      focused.totals.reportedTokens += 1234;
      focused.plugins[0].calls += 7;
      focused.plugins[0].tokens += 1234;
      focused.models.push({
        model: 'arrived-after-overview',
        pluginId: 'model-gateway',
        pluginName: 'Model Gateway',
        calls: 7,
        tokens: 1234,
        errors: 0,
        averageLatencyMs: 1000,
      });
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: focused,
      }),
    });
  });

  const chart = page.getByTestId('plugin-usage-chart');
  const table = page.getByTestId('usage-model-table');
  const providers = page.getByTestId('usage-provider-breakdown');
  const callSummary = page.locator('section').filter({
    has: page.getByText('API calls', { exact: true }),
  });
  const tokenSummary = page.locator('section').filter({
    has: page.getByText('Reported tokens', { exact: true }),
  });
  const rareHeatmapCell = page
    .getByTestId('usage-heatmap')
    .locator(`rect[data-model="${outsideModel}"]`);
  const firstRow = table.locator(`[data-model="${outsideModel}"]`);
  const secondRow = table.locator(`[data-model="${otherOutsideModel}"]`);
  const firstButton = firstRow.getByRole('button', {
    name: `Highlight ${outsideModel}`,
    exact: true,
  });
  const secondButton = secondRow.getByRole('button', {
    name: `Highlight ${otherOutsideModel}`,
    exact: true,
  });
  const firstProviderButton = providers.getByRole('button', {
    name: `Highlight ${outsideModel}`,
    exact: true,
  });
  const secondProviderButton = providers.getByRole('button', {
    name: `Highlight ${otherOutsideModel}`,
    exact: true,
  });
  const baseLine = chart.locator(
    '[data-testid="usage-model-line"][data-model="model-01"]'
  );
  const firstLine = chart.locator(
    `[data-testid="usage-model-line"][data-model="${outsideModel}"]`
  );
  const secondLine = chart.locator(
    `[data-testid="usage-model-line"][data-model="${otherOutsideModel}"]`
  );
  const otherLine = chart.locator(
    '[data-testid="usage-model-line"][data-model="__other__"]'
  );
  const baseColor = await baseLine.getAttribute('stroke');
  const firstColor = await firstRow
    .locator('span[aria-hidden="true"]')
    .evaluate(span => getComputedStyle(span).backgroundColor);
  const providerTotals = await providers.innerText();
  const tableTotals = await table.innerText();
  const callSummaryText = await callSummary.innerText();
  const tokenSummaryText = await tokenSummary.innerText();
  const initialHeatmapColor = await rareHeatmapCell.getAttribute('fill');
  await expect(table.getByTestId('usage-model-row')).toHaveCount(14);
  await expect(chart.getByTestId('usage-model-line')).toHaveCount(13);
  await expect(firstLine).toHaveCount(0);
  await expect(secondLine).toHaveCount(0);

  try {
    await firstRow.hover();
    await expect(firstRow).toHaveAttribute('data-highlighted', 'true');
    await expect(secondRow).toHaveAttribute('data-highlighted', 'false');
    await expect(otherLine).toHaveAttribute('data-highlighted', 'false');
    await expect
      .poll(() => requestedModels)
      .toContainEqual({
        days: '30',
        model: outsideModel,
        to: String(overview.range.to),
      });
    await expect(chart).toHaveAttribute('aria-busy', 'true');
    await expect(
      chart.getByText(`Loading ${outsideModel}…`, { exact: true })
    ).toBeVisible();
    await firstButton.focus();
    await expect(firstRow).toHaveAttribute('data-highlighted', 'true');
    await expect(secondButton).toHaveAttribute('aria-pressed', 'false');
    await firstButton.click();
    await expect(firstButton).toHaveAttribute('aria-pressed', 'true');
    await expect(firstProviderButton).toHaveAttribute('aria-pressed', 'true');
    await expect(secondProviderButton).toHaveAttribute('aria-pressed', 'false');

    releaseFirstFocus();
    await expect(firstLine).toHaveAttribute('data-highlighted', 'true');
    await expect(chart).toHaveAttribute('aria-busy', 'false');
    await expect(firstButton).toHaveAttribute('aria-pressed', 'true');
    await expect(chart.getByTestId('usage-model-line')).toHaveCount(14);
    await expect(baseLine).toHaveAttribute('stroke', baseColor!);
    await expect(firstLine).toHaveCSS('stroke', firstColor);
    await expect(rareHeatmapCell).toHaveCSS('fill', firstColor);
    await expect(otherLine).toHaveAttribute('data-highlighted', 'false');
    await expect(table.getByTestId('usage-model-row')).toHaveCount(14);
    await expect(
      table.getByText('arrived-after-overview', { exact: true })
    ).toHaveCount(0);
    expect(await table.innerText()).toBe(tableTotals);
    expect(await providers.innerText()).toBe(providerTotals);
    expect(await callSummary.innerText()).toBe(callSummaryText);
    expect(await tokenSummary.innerText()).toBe(tokenSummaryText);
    const detail = chart.getByTestId('usage-chart-day-detail');
    await expect(
      detail.locator(`[data-model="${outsideModel}"] span`).last()
    ).toHaveText('3');
    await expect(
      detail.locator('[data-model="__other__"] span').last()
    ).toHaveText('1');
    await expect(detail.getByText('178 Calls', { exact: true })).toBeVisible();
    await chart.getByRole('button', { name: 'Tokens', exact: true }).click();
    await expect(
      detail.locator(`[data-model="${outsideModel}"] span`).last()
    ).toHaveText('420');
    await expect(
      detail.locator('[data-model="__other__"] span').last()
    ).toHaveText('230');

    await secondButton.click();
    await expect
      .poll(() => requestedModels)
      .toContainEqual({
        days: '30',
        model: otherOutsideModel,
        to: String(overview.range.to),
      });
    await expect(secondButton).toHaveAttribute('aria-pressed', 'true');
    await expect(secondProviderButton).toHaveAttribute('aria-pressed', 'true');
    await expect(firstButton).toHaveAttribute('aria-pressed', 'false');
    await expect(firstProviderButton).toHaveAttribute('aria-pressed', 'false');
    await expect(secondLine).toHaveAttribute('data-highlighted', 'true');
    await expect(firstRow).toHaveAttribute('data-highlighted', 'false');
    await chart.getByTestId('usage-chart-day-slider').focus();
    await page.mouse.move(0, 0);
    await expect(secondLine).toHaveAttribute('data-highlighted', 'true');
    await expect(baseLine).toHaveAttribute('stroke', baseColor!);
    expect(await providers.innerText()).toBe(providerTotals);

    await chart
      .getByRole('button', { name: 'Show all models', exact: true })
      .click();
    await expect(firstButton).toHaveAttribute('aria-pressed', 'false');
    await expect(secondButton).toHaveAttribute('aria-pressed', 'false');
    await expect(firstProviderButton).toHaveAttribute('aria-pressed', 'false');
    await expect(secondProviderButton).toHaveAttribute('aria-pressed', 'false');
    await expect(
      chart.locator('[data-testid="usage-model-line"][data-highlighted="true"]')
    ).toHaveCount(0);
    expect(await table.innerText()).toBe(tableTotals);
    expect(await providers.innerText()).toBe(providerTotals);
    expect(await callSummary.innerText()).toBe(callSummaryText);
    expect(await tokenSummary.innerText()).toBe(tokenSummaryText);
    await expect(rareHeatmapCell).toHaveAttribute('fill', initialHeatmapColor!);
  } finally {
    releaseFirstFocus();
  }
});

test('unmetered models keep call history and explain missing reported tokens', async ({
  page,
}) => {
  await openModelUsage(page, modelUsageFixture(false));
  const chart = page.getByTestId('plugin-usage-chart');
  await expect(chart.getByTestId('usage-model-line')).toHaveCount(3);
  await chart.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(
    chart.getByText('No tokens reported in this period', { exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByTestId('usage-model-table')
      .locator('tbody tr')
      .first()
      .locator('td')
      .nth(2)
  ).toHaveText('—');
  await chart.getByRole('button', { name: 'Calls', exact: true }).click();
  await expect(
    chart.getByText('No tokens reported in this period', { exact: true })
  ).toHaveCount(0);
  await expect(chart.getByTestId('usage-model-line')).toHaveCount(3);
});

test('older usage responses retain an aggregate chart without inventing model history', async ({
  page,
}) => {
  const usage = modelUsageFixture();
  delete usage.modelSeries;
  await openModelUsage(page, usage);
  const chart = page.getByTestId('plugin-usage-chart');
  await expect(chart.getByTestId('usage-model-line')).toHaveCount(1);
  await expect(
    chart
      .getByTestId('usage-model-legend')
      .getByRole('button', { name: 'All models', exact: true })
  ).toBeVisible();
  await expect(
    chart.locator(`[data-testid="usage-model-line"][data-model="${gptModel}"]`)
  ).toHaveCount(0);
  await expect(
    page.getByTestId('usage-model-table').getByText(gptModel, { exact: true })
  ).toBeVisible();
  await chart.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(chart.getByTestId('usage-model-line')).toHaveCount(1);
});

for (const variant of [
  { mode: 'dark' as const, language: 'en', screenshot: 'dark' },
  { mode: 'light' as const, language: 'en', screenshot: 'light' },
  { mode: 'dark' as const, language: 'ar', screenshot: 'ar' },
]) {
  test(`model usage fits a narrow ${variant.screenshot} viewport`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openModelUsage(
      page,
      modelUsageFixture(),
      variant.mode,
      variant.language
    );
    await page.getByTestId('sidebar-toggle-size').click();
    await expect
      .poll(
        async () =>
          (await page.getByTestId('sidebar').boundingBox())?.width ?? Infinity
      )
      .toBeLessThan(90);
    await expect(page.locator('html')).toHaveAttribute(
      'dir',
      variant.language === 'ar' ? 'rtl' : 'ltr'
    );
    if (variant.mode === 'dark') {
      await expect(page.locator('html')).toHaveClass(/dark/);
    } else {
      await expect(page.locator('html')).not.toHaveClass(/dark/);
    }
    const chart = page.getByTestId('plugin-usage-chart');
    await expect(chart.getByTestId('usage-model-line')).toHaveCount(3);
    await expect(page.getByTestId('usage-heatmap')).toBeVisible();
    await expect(page.getByTestId('usage-model-table')).toBeVisible();
    const gptButton = chart
      .getByTestId('usage-model-legend')
      .getByRole('button', { name: gptModel, exact: true });
    await gptButton.click();
    await expect(gptButton).toHaveAttribute('aria-pressed', 'true');
    const slider = chart.getByTestId('usage-chart-day-slider');
    await slider.focus();
    await slider.press('Home');
    await expect(slider).toHaveValue('0');
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        )
      )
      .toBeLessThanOrEqual(1);
    expect((await chart.boundingBox())!.width).toBeLessThanOrEqual(390);
    const clippedAxisLabels = await chart
      .locator('svg[role="img"]')
      .evaluate(svg => {
        const bounds = svg.getBoundingClientRect();
        return Array.from(svg.querySelectorAll('text'))
          .filter(label => {
            const labelBounds = label.getBoundingClientRect();
            return (
              labelBounds.left < bounds.left - 1 ||
              labelBounds.right > bounds.right + 1
            );
          })
          .map(label => label.textContent);
      });
    expect(clippedAxisLabels).toEqual([]);
    // Keep the narrow layout, but fit the full card below the sticky tab bar
    // in the review image after exercising the shorter mobile viewport.
    await page.setViewportSize({ width: 390, height: 1200 });
    await chart.scrollIntoViewIfNeeded();
    await chart.screenshot({
      path: `/tmp/libre-usage-${variant.screenshot}.png`,
    });
  });
}
