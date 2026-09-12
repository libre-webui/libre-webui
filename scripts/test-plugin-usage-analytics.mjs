import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const DAY_MS = 24 * 60 * 60 * 1000;
const fixtureNow = Date.UTC(2026, 8, 11, 12);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-plugin-usage-'));
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.DATA_DIR = tempDir;
process.env.PLUGINS_DIR = path.join(tempDir, 'plugins');
process.env.JWT_SECRET ||= 'plugin-usage-test-jwt-secret';

const usageModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'pluginUsageService.js')
  ).href
);
const dbModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
);

test.after(() => {
  dbModule.closeDatabase();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const modelSeriesEvents = () => {
  const today = fixtureNow - 12 * 60 * 60 * 1000;
  const earlier = today - 2 * DAY_MS;
  const events = [
    { model: 'shared', pluginId: 'first', createdAt: earlier, tokens: 10 },
    {
      model: 'shared',
      pluginId: 'second',
      createdAt: earlier,
      tokens: 20,
      status: 'error',
    },
    { model: 'shared', pluginId: 'first', createdAt: today, tokens: 30 },
  ];
  for (let index = 0; index < 13; index++) {
    const model = `model-${String(index).padStart(2, '0')}`;
    events.push(
      { model, createdAt: earlier, tokens: 1 },
      {
        model,
        createdAt: today,
        tokens: 2,
        status: index === 12 ? 'error' : index === 11 ? 'cancelled' : 'success',
      }
    );
  }
  for (let index = 0; index < 8; index++) {
    events.push(
      { model: 'outside-range', createdAt: today - 6 * DAY_MS - 1 },
      { model: 'future', createdAt: fixtureNow + 1, tokens: 100 }
    );
  }
  return events;
};

const recordModelSeriesEvents = async (
  service,
  events = modelSeriesEvents()
) => {
  for (const event of events) {
    await service.record({
      userId: 'chart-user',
      pluginId: event.pluginId ?? 'first',
      pluginName: event.pluginId ?? 'first',
      capability: 'chat',
      model: event.model,
      status: event.status ?? 'success',
      durationMs: 1,
      createdAt: event.createdAt,
      ...(event.tokens === undefined
        ? {}
        : {
            tokens: {
              promptTokens: event.tokens,
              completionTokens: 0,
              totalTokens: event.tokens,
            },
          }),
    });
  }
};

const assertDailyModelReconciliation = analytics => {
  for (const entry of analytics.modelSeries) {
    assert.deepEqual(
      entry.points.map(point => point.timestamp),
      analytics.series.map(point => point.timestamp)
    );
  }
  for (const [index, point] of analytics.series.entries()) {
    for (const metric of ['calls', 'tokens', 'errors']) {
      assert.equal(
        analytics.modelSeries.reduce(
          (sum, entry) => sum + entry.points[index][metric],
          0
        ),
        point[metric],
        `${metric} must reconcile at ${point.timestamp}`
      );
    }
  }
};

test('normalizes provider token usage without estimating missing counters', () => {
  assert.deepEqual(
    usageModule.normalizeProviderTokenUsage({
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      },
    }),
    { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
  );
  assert.deepEqual(
    usageModule.normalizeProviderTokenUsage({
      usage: { input_tokens: 80, output_tokens: 20 },
    }),
    { promptTokens: 80, completionTokens: 20, totalTokens: 100 }
  );
  assert.equal(
    usageModule.normalizeProviderTokenUsage({ usage: {} }),
    undefined
  );
});

test('aggregates calls, provider-reported tokens, failures, and capability units', async () => {
  const service = new usageModule.PluginUsageService();
  const now = Date.now();
  await service.record({
    userId: 'user-one',
    pluginId: 'openai',
    pluginName: 'OpenAI',
    capability: 'chat',
    model: 'gpt-test',
    status: 'success',
    durationMs: 800,
    tokens: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
    createdAt: now - 60_000,
  });
  await service.record({
    userId: 'user-two',
    pluginId: 'openai',
    pluginName: 'OpenAI',
    capability: 'chat',
    model: 'gpt-test',
    status: 'error',
    durationMs: 1200,
    createdAt: now - 30_000,
  });
  await service.record({
    userId: 'user-one',
    pluginId: 'image-provider',
    pluginName: 'Image Provider',
    capability: 'image',
    model: 'image-test',
    status: 'success',
    durationMs: 4000,
    outputUnits: 2,
    unitKind: 'images',
    createdAt: now - 10_000,
  });
  await service.record({
    pluginId: 'system-probe',
    pluginName: 'System Probe',
    capability: 'chat',
    model: 'probe',
    status: 'success',
    durationMs: 1,
    createdAt: now,
  });

  const analytics = await service.getAnalytics(7);
  assert.equal(analytics.totals.calls, 3);
  assert.equal(analytics.totals.successfulCalls, 2);
  assert.equal(analytics.totals.failedCalls, 1);
  assert.equal(analytics.totals.meteredCalls, 1);
  assert.equal(analytics.totals.reportedTokens, 140);
  assert.equal(analytics.totals.uniqueUsers, 2);
  assert.equal(
    analytics.series.reduce((sum, point) => sum + point.calls, 0),
    3
  );
  assert.deepEqual(
    analytics.modelSeries.map(entry => entry.model),
    ['gpt-test', 'image-test']
  );
  assertDailyModelReconciliation(analytics);
  assert.deepEqual(
    analytics.models.map(model => [model.model, model.calls, model.tokens]),
    [
      ['gpt-test', 2, 140],
      ['image-test', 1, 0],
    ]
  );
  assert.equal(
    analytics.capabilities.find(item => item.capability === 'image')
      ?.outputUnits,
    2
  );

  // The contribution heatmap always covers a trailing year, independent of
  // the requested range, and ranks each day's models by call count.
  assert.equal(analytics.heatmap.days, 365);
  assert.equal(
    analytics.heatmap.cells.reduce((sum, cell) => sum + cell.calls, 0),
    3
  );
  assert.equal(analytics.heatmap.models[0], 'gpt-test');
  const today = analytics.heatmap.cells.find(
    cell =>
      cell.timestamp === analytics.heatmap.from + 364 * 24 * 60 * 60 * 1000
  );
  assert.ok(today, 'today has a heatmap cell');
  assert.equal(today.models[0].model, 'gpt-test');
  assert.equal(today.models[0].calls, 2);

  const columns = dbModule
    .getDatabase()
    .prepare('PRAGMA table_info(plugin_usage_events)')
    .all()
    .map(column => column.name);
  assert.ok(!columns.includes('prompt'));
  assert.ok(!columns.includes('response'));
  assert.ok(!columns.includes('endpoint'));
  assert.ok(!columns.includes('error_body'));
});

test('model chart series bound names, combine providers, and reconcile UTC daily counters', async t => {
  t.mock.method(Date, 'now', () => fixtureNow);
  dbModule.getDatabase().prepare('DELETE FROM plugin_usage_events').run();
  const service = new usageModule.PluginUsageService();
  await recordModelSeriesEvents(service);

  const analytics = await service.getAnalytics(7);
  const today = fixtureNow - 12 * 60 * 60 * 1000;
  assert.equal(analytics.range.from, today - 6 * DAY_MS);
  assert.equal(analytics.totals.calls, 29);
  assert.equal(analytics.totals.reportedTokens, 99);
  assert.equal(analytics.totals.failedCalls, 2);
  assert.equal(analytics.totals.cancelledCalls, 1);
  assert.deepEqual(
    analytics.modelSeries.map(entry => entry.model),
    [
      'shared',
      ...Array.from(
        { length: 11 },
        (_, index) => `model-${String(index).padStart(2, '0')}`
      ),
      null,
    ]
  );
  assert.equal(
    analytics.models.filter(entry => entry.model === 'shared').length,
    2
  );
  assert.deepEqual(
    analytics.modelSeries[0].points.filter(point => point.calls > 0),
    [
      { timestamp: today - 2 * DAY_MS, calls: 2, tokens: 30, errors: 1 },
      { timestamp: today, calls: 1, tokens: 30, errors: 0 },
    ]
  );
  assert.deepEqual(
    analytics.modelSeries.at(-1).points.filter(point => point.calls > 0),
    [
      { timestamp: today - 2 * DAY_MS, calls: 2, tokens: 2, errors: 0 },
      { timestamp: today, calls: 2, tokens: 4, errors: 1 },
    ]
  );
  assert.deepEqual(
    analytics.series.filter(point => point.calls > 0),
    [
      { timestamp: today - 2 * DAY_MS, calls: 15, tokens: 43, errors: 1 },
      { timestamp: today, calls: 14, tokens: 56, errors: 1 },
    ]
  );
  for (const entry of analytics.modelSeries) {
    assert.deepEqual(entry.points[5], {
      timestamp: today - DAY_MS,
      calls: 0,
      tokens: 0,
      errors: 0,
    });
  }
  assertDailyModelReconciliation(analytics);
  assert.equal(analytics.heatmap.models[0], 'outside-range');

  const oneDay = await service.getAnalytics(1);
  assert.deepEqual(
    oneDay.modelSeries.map(entry => entry.model),
    [
      ...Array.from(
        { length: 12 },
        (_, index) => `model-${String(index).padStart(2, '0')}`
      ),
      null,
    ]
  );
  assert.deepEqual(oneDay.modelSeries.at(-1).points, [
    { timestamp: today, calls: 2, tokens: 32, errors: 1 },
  ]);
  assertDailyModelReconciliation(oneDay);
});

test('focused model series isolate exact rare names without double counting', async t => {
  t.mock.method(Date, 'now', () => fixtureNow);
  dbModule.getDatabase().prepare('DELETE FROM plugin_usage_events').run();
  const service = new usageModule.PluginUsageService();
  await recordModelSeriesEvents(service);
  const overview = await service.getAnalytics(7);
  const focused = await service.getAnalytics(7, 'model-12');
  const today = fixtureNow - 12 * 60 * 60 * 1000;
  assert.equal(
    focused.modelSeries.filter(entry => entry.model !== null).length,
    13
  );
  assert.equal(focused.modelSeries.length, 14);
  assert.deepEqual(
    focused.modelSeries
      .find(entry => entry.model === 'model-12')
      .points.filter(point => point.calls > 0),
    [
      { timestamp: today - 2 * DAY_MS, calls: 1, tokens: 1, errors: 0 },
      { timestamp: today, calls: 1, tokens: 2, errors: 1 },
    ]
  );
  assert.deepEqual(
    focused.modelSeries
      .find(entry => entry.model === null)
      .points.filter(point => point.calls > 0),
    [
      { timestamp: today - 2 * DAY_MS, calls: 1, tokens: 1, errors: 0 },
      { timestamp: today, calls: 1, tokens: 2, errors: 0 },
    ]
  );
  assert.deepEqual(focused.series, overview.series);
  assert.deepEqual(focused.totals, overview.totals);
  assert.deepEqual(focused.models, overview.models);
  assertDailyModelReconciliation(focused);
  for (const name of [
    'shared',
    'missing',
    'outside-range',
    'future',
    'MODEL-12',
  ]) {
    assert.deepEqual(
      (await service.getAnalytics(7, name)).modelSeries,
      overview.modelSeries
    );
  }

  const quotedModel = "z模型's exact name ";
  await recordModelSeriesEvents(service, [
    {
      model: quotedModel,
      pluginId: 'first',
      createdAt: today - 2 * DAY_MS,
      tokens: 7,
    },
    {
      model: quotedModel,
      pluginId: 'second',
      createdAt: today,
      tokens: 11,
      status: 'error',
    },
  ]);
  const quotedOverview = await service.getAnalytics(7);
  const quotedFocus = await service.getAnalytics(7, quotedModel);
  assert.equal(
    quotedFocus.modelSeries.filter(entry => entry.model !== null).length,
    13
  );
  assert.deepEqual(
    quotedFocus.modelSeries
      .find(entry => entry.model === quotedModel)
      .points.filter(point => point.calls > 0),
    [
      { timestamp: today - 2 * DAY_MS, calls: 1, tokens: 7, errors: 0 },
      { timestamp: today, calls: 1, tokens: 11, errors: 1 },
    ]
  );
  assert.deepEqual(quotedFocus.series, quotedOverview.series);
  assertDailyModelReconciliation(quotedFocus);
  for (const name of [quotedModel.trim(), "z模型' OR 1=1 --"]) {
    assert.deepEqual(
      (await service.getAnalytics(7, name)).modelSeries,
      quotedOverview.modelSeries
    );
  }
});

test('focused usage snapshots exclude later events and keep overview UTC boundaries', async t => {
  let now = fixtureNow;
  t.mock.method(Date, 'now', () => now);
  dbModule.getDatabase().prepare('DELETE FROM plugin_usage_events').run();
  const service = new usageModule.PluginUsageService();
  await recordModelSeriesEvents(service);
  const overview = await service.getAnalytics(7);
  await recordModelSeriesEvents(service, [
    { model: 'model-12', createdAt: overview.range.to + 2, tokens: 123 },
  ]);
  now += DAY_MS;

  const focused = await service.getAnalytics(7, 'model-12', overview.range.to);
  assert.deepEqual(focused.range, overview.range);
  assert.deepEqual(focused.series, overview.series);
  assert.deepEqual(focused.totals, overview.totals);
  assert.deepEqual(focused.heatmap, overview.heatmap);
  assert.equal(
    focused.modelSeries
      .find(entry => entry.model === 'model-12')
      .points.reduce((sum, point) => sum + point.tokens, 0),
    3
  );
  assertDailyModelReconciliation(focused);
  const live = await service.getAnalytics(7, 'model-12');
  assert.equal(live.range.to, now);
  assert.equal(live.range.from, overview.range.from + DAY_MS);
  assert.ok(live.totals.calls > overview.totals.calls);
  assert.equal((await service.getAnalytics(1, 'model-12', 0)).range.to, 0);
});

test('empty model usage has no named or remaining series and zero-filled totals', async () => {
  dbModule.getDatabase().prepare('DELETE FROM plugin_usage_events').run();
  const analytics = await new usageModule.PluginUsageService().getAnalytics(7);
  assert.deepEqual(analytics.modelSeries, []);
  assert.equal(analytics.series.length, 7);
  assertDailyModelReconciliation(analytics);
});

const postgresUrl = process.env.TEST_POSTGRES_URL?.trim();
test(
  'PostgreSQL model series preserve bounded model selection and daily aggregation',
  { skip: postgresUrl ? false : 'TEST_POSTGRES_URL is not configured' },
  async () => {
    assert.match(new URL(postgresUrl).pathname, /test/i);
    const { resolvePostgresRuntimeConfig } =
      await import('../backend/dist/persistence/postgresConfig.js');
    const { createPostgresDatabase } =
      await import('../backend/dist/persistence/postgresDatabase.js');
    const { createPostgresTransactionalExtensionRepositories } =
      await import('../backend/dist/persistence/postgresExtensionRepositories.js');
    const database = createPostgresDatabase(
      resolvePostgresRuntimeConfig({
        DATABASE_URL: postgresUrl,
        DATABASE_SSL_MODE: 'disable',
        POSTGRES_APPLICATION_NAME: 'libre-usage-series-test',
      })
    );
    try {
      await database.transaction(async client => {
        await client.query(`CREATE TEMP TABLE plugin_usage_events (
          model TEXT NOT NULL, plugin_id TEXT NOT NULL, created_at BIGINT NOT NULL,
          total_tokens BIGINT, status TEXT NOT NULL
        ) ON COMMIT DROP`);
        for (const event of modelSeriesEvents()) {
          await client.query(
            `INSERT INTO plugin_usage_events
               (model, plugin_id, created_at, total_tokens, status)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              event.model,
              event.pluginId ?? 'first',
              event.createdAt,
              event.tokens ?? null,
              event.status ?? 'success',
            ]
          );
        }
        const repository =
          createPostgresTransactionalExtensionRepositories(client).pluginUsage;
        const from = fixtureNow - 12 * 60 * 60 * 1000 - 6 * DAY_MS;
        const rows = await repository.modelSeries(from, fixtureNow, DAY_MS, 12);
        assert.deepEqual(
          [...new Set(rows.map(row => row.model))],
          [
            'shared',
            ...Array.from(
              { length: 11 },
              (_, index) => `model-${String(index).padStart(2, '0')}`
            ),
            null,
          ]
        );
        assert.deepEqual(
          rows
            .filter(row => row.model === null)
            .map(row => ({
              bucket: Number(row.bucket),
              calls: Number(row.calls),
              tokens: Number(row.tokens),
              errors: Number(row.errors),
            })),
          [
            { bucket: 4, calls: 2, tokens: 2, errors: 0 },
            { bucket: 6, calls: 2, tokens: 4, errors: 1 },
          ]
        );
        const assertRowsReconcile = async modelRows => {
          for (const total of await repository.series(
            from,
            fixtureNow,
            DAY_MS
          )) {
            for (const metric of ['calls', 'tokens', 'errors']) {
              assert.equal(
                modelRows
                  .filter(row => Number(row.bucket) === Number(total.bucket))
                  .reduce((sum, row) => sum + Number(row[metric]), 0),
                Number(total[metric])
              );
            }
          }
        };
        await assertRowsReconcile(rows);
        const focusedRows = await repository.modelSeries(
          from,
          fixtureNow,
          DAY_MS,
          12,
          'model-12'
        );
        assert.equal(new Set(focusedRows.map(row => row.model)).size, 14);
        assert.deepEqual(
          focusedRows
            .filter(row => row.model === null)
            .map(row => ({
              bucket: Number(row.bucket),
              calls: Number(row.calls),
              tokens: Number(row.tokens),
              errors: Number(row.errors),
            })),
          [
            { bucket: 4, calls: 1, tokens: 1, errors: 0 },
            { bucket: 6, calls: 1, tokens: 2, errors: 0 },
          ]
        );
        await assertRowsReconcile(focusedRows);
        for (const name of ['shared', 'missing', 'outside-range', 'future']) {
          assert.deepEqual(
            await repository.modelSeries(from, fixtureNow, DAY_MS, 12, name),
            rows
          );
        }

        const quotedModel = "z模型's exact name ";
        for (const [provider, bucket, tokens] of [
          ['first', 4, 7],
          ['second', 6, 11],
        ]) {
          await client.query(
            `INSERT INTO plugin_usage_events
               (model, plugin_id, created_at, total_tokens, status)
             VALUES ($1, $2, $3, $4, 'success')`,
            [quotedModel, provider, from + bucket * DAY_MS, tokens]
          );
        }
        const quotedRows = await repository.modelSeries(
          from,
          fixtureNow,
          DAY_MS,
          12,
          quotedModel
        );
        assert.equal(new Set(quotedRows.map(row => row.model)).size, 14);
        assert.deepEqual(
          quotedRows
            .filter(row => row.model === quotedModel)
            .map(row => ({
              bucket: Number(row.bucket),
              calls: Number(row.calls),
              tokens: Number(row.tokens),
            })),
          [
            { bucket: 4, calls: 1, tokens: 7 },
            { bucket: 6, calls: 1, tokens: 11 },
          ]
        );
        await assertRowsReconcile(quotedRows);
        const quotedOverview = await repository.modelSeries(
          from,
          fixtureNow,
          DAY_MS,
          12
        );
        for (const name of [quotedModel.trim(), "z模型' OR 1=1 --"]) {
          assert.deepEqual(
            await repository.modelSeries(from, fixtureNow, DAY_MS, 12, name),
            quotedOverview
          );
        }
      });
    } finally {
      await database.close();
    }
  }
);

test('rejects analytics windows larger than the public API permits by clamping service input', async () => {
  const service = new usageModule.PluginUsageService();
  assert.equal((await service.getAnalytics(0)).range.days, 1);
  assert.equal((await service.getAnalytics(999)).range.days, 365);
});

test('the usage endpoint is explicitly protected by administrator middleware', () => {
  const routeSource = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'plugins.ts'),
    'utf8'
  );
  assert.match(routeSource, /router\.get\(\s*['"]\/usage['"],\s*requireAdmin,/);
});

test('usage route rejects malformed model focus and preserves exact scalar names', async t => {
  t.mock.method(Date, 'now', () => fixtureNow);
  const { default: router } = await import('../backend/dist/routes/plugins.js');
  const route = router.stack.find(
    layer => layer.route?.path === '/usage'
  ).route;
  const handler = route.stack.at(-1).handle;
  const requests = [];
  t.mock.method(
    usageModule.default,
    'getAnalytics',
    async (days, model, snapshotTo) => {
      requests.push({ days, model, snapshotTo });
      return { marker: 'usage' };
    }
  );
  const request = async query => {
    let status = 200;
    let body;
    const response = {
      status(code) {
        status = code;
        return this;
      },
      json(value) {
        body = value;
        return this;
      },
    };
    await handler({ query }, response);
    return { status, body };
  };

  for (const model of [
    '',
    'x'.repeat(1025),
    ['one'],
    ['one', 'two'],
    { name: 'one' },
    null,
  ]) {
    const response = await request({ model });
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
  }
  assert.equal(
    requests.length,
    0,
    'invalid focus must not reach analytics queries'
  );
  for (const model of [
    undefined,
    'model-12',
    " z模型's name ",
    'x'.repeat(1024),
  ]) {
    const response = await request({ days: '7', model });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      success: true,
      data: { marker: 'usage' },
    });
    assert.deepEqual(requests.at(-1), {
      days: 7,
      model,
      snapshotTo: undefined,
    });
  }
  const callsBeforeInvalidSnapshots = requests.length;
  for (const to of [
    '',
    ' ',
    ['1'],
    { timestamp: '1' },
    null,
    1,
    '1.5',
    '-1',
    'NaN',
    'Infinity',
    '9007199254740992',
    String(fixtureNow + 1),
  ]) {
    const response = await request({ model: 'model-12', to });
    assert.equal(response.status, 400);
    assert.equal(response.body.success, false);
  }
  assert.equal((await request({ to: String(fixtureNow) })).status, 400);
  assert.equal(requests.length, callsBeforeInvalidSnapshots);
  const exactModel = " z模型's name ";
  for (const to of ['0', String(fixtureNow - 1), String(fixtureNow)]) {
    const response = await request({ days: '7', model: exactModel, to });
    assert.equal(response.status, 200);
    assert.deepEqual(requests.at(-1), {
      days: 7,
      model: exactModel,
      snapshotTo: Number(to),
    });
  }
});
