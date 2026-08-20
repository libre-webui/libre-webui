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

/*
 * Cost and quota governance (ADMIN-01): versioned tariff resolution,
 * per-event pricing with unmetered surfacing, UTC budget period math,
 * cost analytics attribution by user/plugin/model/day, CSV export, hard
 * budget admission blocking with fail-open cache semantics, and
 * single-fire threshold alerts through notification dedup keys.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-costs-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'cost-governance-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '7'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const { initializeCoordinator } = await distModule(
  'platform/coordination/service.js'
);
await initializeCoordinator();

const [
  { getDatabase },
  costs,
  { addGroupMember, createGroup },
  { notificationService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/costGovernanceService.js'),
  distModule('services/groupService.js'),
  distModule('services/notificationService.js'),
]);
const {
  default: costGovernanceService,
  BudgetExceededError,
  costForEvent,
  periodStart,
  resolveTariff,
} = costs;

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const upsertUser = userId => {
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, avatar, created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', 'user', NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
    )
    .run(userId, userId, now, now);
};

const insertUsage = event => {
  getDatabase()
    .prepare(
      `INSERT INTO plugin_usage_events
         (id, user_id, plugin_id, plugin_name, capability, model, status,
          prompt_tokens, completion_tokens, total_tokens, input_units,
          output_units, unit_kind, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      event.id ?? randomUUID(),
      event.userId,
      event.pluginId,
      event.pluginId,
      event.capability ?? 'chat',
      event.model,
      'success',
      event.promptTokens ?? null,
      event.completionTokens ?? null,
      (event.promptTokens ?? 0) + (event.completionTokens ?? 0) || null,
      0,
      event.outputUnits ?? 0,
      event.outputUnits ? 'images' : null,
      120,
      event.at ?? Date.now()
    );
};

test('tariff resolution prefers exact models and the newest effective row', async () => {
  const admin = 'cost-admin';
  upsertUser(admin);
  const base = Date.UTC(2026, 0, 1);
  const oldRate = await costGovernanceService.createTariff(
    {
      pluginId: 'openai',
      model: 'gpt-test',
      inputPerMillion: 1,
      outputPerMillion: 2,
      effectiveFrom: base,
    },
    admin
  );
  const newRate = await costGovernanceService.createTariff(
    {
      pluginId: 'openai',
      model: 'gpt-test',
      inputPerMillion: 2,
      outputPerMillion: 4,
      effectiveFrom: base + 1000,
    },
    admin
  );
  const pluginWide = await costGovernanceService.createTariff(
    { pluginId: 'openai', inputPerMillion: 10, effectiveFrom: base },
    admin
  );
  const tariffs = await costGovernanceService.listTariffs();

  assert.equal(
    resolveTariff(tariffs, 'openai', 'gpt-test', base + 500)?.id,
    oldRate.id,
    'the newest row at or before the event applies'
  );
  assert.equal(
    resolveTariff(tariffs, 'openai', 'gpt-test', base + 5000)?.id,
    newRate.id
  );
  assert.equal(
    resolveTariff(tariffs, 'openai', 'other-model', base + 5000)?.id,
    pluginWide.id,
    'plugin-wide rows back-fill unknown models'
  );
  assert.equal(resolveTariff(tariffs, 'unknown', 'gpt-test', base + 5000), null);

  const priced = costForEvent(
    {
      plugin_id: 'openai',
      model: 'gpt-test',
      created_at: base + 5000,
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
      output_units: 0,
    },
    tariffs
  );
  assert.ok(Math.abs(priced - (2 + 2)) < 1e-9);
  assert.equal(
    costForEvent(
      {
        plugin_id: 'none',
        model: 'x',
        created_at: base,
        prompt_tokens: 10,
        completion_tokens: 10,
        output_units: 0,
      },
      tariffs
    ),
    null,
    'events without a tariff stay unmetered'
  );

  await assert.rejects(
    costGovernanceService.createTariff({ pluginId: 'openai' }, admin),
    /At least one price/
  );
});

test('budget periods use UTC day, ISO week, and calendar month boundaries', () => {
  // 2026-08-19 is a Wednesday.
  const wednesday = Date.UTC(2026, 7, 19, 15, 30);
  assert.equal(periodStart('daily', wednesday), Date.UTC(2026, 7, 19));
  assert.equal(periodStart('weekly', wednesday), Date.UTC(2026, 7, 17));
  assert.equal(periodStart('monthly', wednesday), Date.UTC(2026, 7, 1));
});

test('cost analytics attribute spend and surface unmetered events', async () => {
  upsertUser('cost-user-a');
  upsertUser('cost-user-b');
  const now = Date.now();
  insertUsage({
    userId: 'cost-user-a',
    pluginId: 'openai',
    model: 'gpt-test',
    promptTokens: 1_000_000,
    completionTokens: 0,
    at: now - 1000,
  });
  insertUsage({
    userId: 'cost-user-b',
    pluginId: 'openai',
    model: 'gpt-test',
    promptTokens: 0,
    completionTokens: 1_000_000,
    at: now - 900,
  });
  insertUsage({
    userId: 'cost-user-b',
    pluginId: 'untariffed',
    model: 'mystery',
    promptTokens: 55,
    completionTokens: 55,
    at: now - 800,
  });

  const analytics = await costGovernanceService.getCostAnalytics(7, now);
  assert.ok(analytics.totalUsd > 0);
  assert.ok(analytics.unmeteredEvents >= 1);
  const userA = analytics.byUser.find(row => row.userId === 'cost-user-a');
  const userB = analytics.byUser.find(row => row.userId === 'cost-user-b');
  assert.ok(userA && userB);
  assert.ok(Math.abs(userA.usd - 2) < 1e-9, 'input tokens priced at $2/M');
  assert.ok(Math.abs(userB.usd - 4) < 1e-9, 'output tokens priced at $4/M');
  const model = analytics.byModel.find(row => row.model === 'gpt-test');
  assert.equal(model?.events, 2);

  const csv = await costGovernanceService.exportCostsCsv(7, now);
  const lines = csv.trim().split('\n');
  assert.match(lines[0], /^timestamp,user_id,plugin_id,model/);
  assert.ok(lines.some(line => line.includes('cost-user-a')));
  assert.ok(
    lines.some(line => line.includes('untariffed') && line.endsWith(',')),
    'unpriced rows leave the cost column empty'
  );
});

test('hard budgets block exhausted principals and fail open otherwise', async () => {
  upsertUser('cost-blocked');
  upsertUser('cost-free');
  const now = Date.now();
  insertUsage({
    userId: 'cost-blocked',
    pluginId: 'openai',
    model: 'gpt-test',
    promptTokens: 2_000_000,
    completionTokens: 0,
    at: now - 500,
  });
  await costGovernanceService.saveBudget(
    {
      name: 'Per-user hard cap',
      principalType: 'user',
      principalId: 'cost-blocked',
      period: 'monthly',
      amountUsd: 1,
      mode: 'hard',
    },
    'cost-admin'
  );

  await assert.rejects(
    costGovernanceService.assertWithinBudget('cost-blocked', now),
    error =>
      error instanceof BudgetExceededError &&
      /Per-user hard cap/.test(error.message)
  );
  await costGovernanceService.assertWithinBudget('cost-free', now);

  // Group budgets cover members through fresh membership resolution.
  upsertUser('cost-grouped');
  const group = await createGroup(
    { name: 'cost-team', description: null },
    'cost-admin'
  );
  await addGroupMember(group.id, 'cost-grouped', 'cost-admin');
  insertUsage({
    userId: 'cost-grouped',
    pluginId: 'openai',
    model: 'gpt-test',
    promptTokens: 2_000_000,
    completionTokens: 0,
    at: now - 400,
  });
  await costGovernanceService.saveBudget(
    {
      name: 'Team hard cap',
      principalType: 'group',
      principalId: group.id,
      period: 'monthly',
      amountUsd: 1,
      mode: 'hard',
    },
    'cost-admin'
  );
  await assert.rejects(
    costGovernanceService.assertWithinBudget('cost-grouped', now),
    /Team hard cap/
  );
});

test('budget alert sweeps notify once per threshold and period', async () => {
  upsertUser('cost-admin');
  const now = Date.now();
  await costGovernanceService.sweepBudgetAlerts(now);
  const firstCount = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS count FROM notifications
        WHERE type = 'budget-alert'`
    )
    .get().count;
  assert.ok(firstCount >= 1, 'exhausted budgets alert the creator');

  await costGovernanceService.sweepBudgetAlerts(now + 1000);
  const secondCount = getDatabase()
    .prepare(
      `SELECT COUNT(*) AS count FROM notifications
        WHERE type = 'budget-alert'`
    )
    .get().count;
  assert.equal(secondCount, firstCount, 'source keys dedupe repeated sweeps');
  void notificationService;
});
