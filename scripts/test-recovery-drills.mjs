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
 * RECOVERY-01: scheduled verified recovery drills. A real drill runs the
 * production pipeline end to end against a live instance: quiescent
 * staging, signed/encrypted archive with the full recovery inventory,
 * isolated restore, restored-environment verification, and measured
 * timings. Also covers the quiescence refusal, failure alerts to
 * administrators, the schedule sweep gating, and the team-profile guard.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-drill-test-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = 'c4'.repeat(32);
process.env.JWT_SECRET = 'recovery-drill-test-secret-that-is-long';
process.env.LIBRE_PLATFORM_MODE = 'solo';
process.env.DATABASE_BACKEND = 'sqlite';
process.env.BLOB_STORE_BACKEND = 'local';
process.env.VECTOR_STORE_BACKEND = 'embedded';
process.env.COORDINATION_BACKEND = 'local';
delete process.env.RECOVERY_DRILL_INTERVAL_HOURS;

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const applicationPersistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const platformStorageModule = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await platformStorageModule.initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: encryptionService,
  env: process.env,
});
const { initializeCoordinator, getCoordinator } = await distModule(
  'platform/coordination/service.js'
);
await initializeCoordinator();
const jobsModule = await distModule('platform/jobs/index.js');
const runtime = jobsModule.initializeDurableJobRuntime({
  role: 'embedded',
  runWorker: false,
  handlers: new Map(),
  env: process.env,
});
const eventsModule = await distModule('platform/events/index.js');
eventsModule.initializeDurableEventGateway(runtime.service, getCoordinator());

const [{ getDatabase }, drills, { notificationService }] = await Promise.all([
  distModule('db.js'),
  distModule('services/recoveryDrillService.js'),
  distModule('services/notificationService.js'),
]);

const database = getDatabase();
const now = Date.now();
const createUser = (id, role) => {
  database
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, account_status, avatar,
          created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', ?, 'active', NULL, ?, ?)`
    )
    .run(id, id, role, now, now);
};
const ADMIN = 'drill-admin';
createUser(ADMIN, 'admin');
createUser('drill-member', 'user');

after(async () => {
  await runtime.close?.();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

test('a manual drill backs up, restores in isolation, verifies, and measures', async () => {
  const drill = await drills.runDrill({ origin: 'manual', createdBy: ADMIN });
  assert.ok(drill);
  assert.equal(drill.status, 'passed');
  assert.equal(drill.origin, 'manual');
  assert.ok(drill.finishedAt >= drill.startedAt);
  assert.ok(drill.snapshotBytes > 0, 'the encrypted archive has real bytes');
  assert.ok(drill.restoreMs >= 0, 'restore duration is the demonstrated RTO');
  assert.equal(drill.rpoSeconds, null, 'the first drill has no predecessor');
  assert.ok(drill.report);
  assert.ok(drill.report.verifyMs >= 0);
  assert.ok(drill.report.restoreVerifyMs >= 0);
  assert.equal(drill.report.archiveBytes, drill.snapshotBytes);

  const listed = await drills.listDrills();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, drill.id);

  // Every drill artifact (staging, keys, archive, restore target) is gone.
  const leftovers = fs
    .readdirSync(os.tmpdir())
    .filter(entry => entry.startsWith('libre-drill-') && entry !== path.basename(dataDir));
  for (const entry of leftovers) {
    assert.ok(
      !fs.existsSync(path.join(os.tmpdir(), entry, 'drill.lwbackup')),
      'no drill archive may be retained'
    );
  }
});

test('a second passing drill reports the spacing since the previous one as RPO', async () => {
  const drill = await drills.runDrill({ origin: 'manual', createdBy: ADMIN });
  assert.equal(drill.status, 'passed');
  assert.ok(
    Number.isInteger(drill.rpoSeconds) && drill.rpoSeconds >= 0,
    'spacing from the previous successful drill'
  );
});

test('a running durable job makes the drill refuse instead of snapshotting mid-write', async () => {
  const queued = await runtime.service.enqueue({
    jobType: 'drill.test.v1',
    actorUserId: ADMIN,
    payload: { mode: 'encrypted', value: {} },
    idempotencyScope: 'drill.test.v1',
    idempotencyKey: 'busy-check',
    maxAttempts: 1,
  });
  database
    .prepare(
      `UPDATE platform_jobs
          SET state = 'running', lease_owner = 'drill-test',
              lease_expires_at = ?
        WHERE id = ?`
    )
    .run(Date.now() + 60_000, queued.id);

  await assert.rejects(
    () => drills.runDrill({ origin: 'manual', createdBy: ADMIN }),
    /quiet moment/
  );
  const failed = (await drills.listDrills())[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /durable job/);
  // The interactive refusal answered the caller; no admin bell alert.
  const inbox = await notificationService.list(ADMIN, { limit: 20 });
  assert.equal(
    inbox.filter(item => item.title === 'Recovery drill failed').length,
    0
  );

  database
    .prepare(
      `UPDATE platform_jobs
          SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL
        WHERE id = ?`
    )
    .run(queued.id);
  const recovered = await drills.runDrill({ origin: 'manual', createdBy: ADMIN });
  assert.equal(recovered.status, 'passed');
});

test('an unattended drill failure alerts every administrator once', async () => {
  // A symlink inside the data directory breaks the physical-file guarantee
  // the archive pipeline enforces, failing the drill mid-flight.
  const linkPath = path.join(dataDir, 'drill-symlink-probe');
  fs.symlinkSync(path.join(dataDir, 'data.sqlite'), linkPath);
  try {
    const failed = await drills.runDrill({ origin: 'manual', createdBy: ADMIN });
    assert.equal(failed.status, 'failed');
    assert.ok(failed.error);
  } finally {
    fs.rmSync(linkPath, { force: true });
  }
  const inbox = await notificationService.list(ADMIN, { limit: 20 });
  assert.equal(
    inbox.filter(item => item.title === 'Recovery drill failed').length,
    1,
    'the admin hears about the failure exactly once'
  );
  const memberInbox = await notificationService.list('drill-member', {
    limit: 20,
  });
  assert.equal(
    memberInbox.filter(item => item.title === 'Recovery drill failed').length,
    0,
    'regular members are not alerted'
  );
});

test('the schedule sweep is opt-in, interval-gated, and self-throttling', async () => {
  delete process.env.RECOVERY_DRILL_INTERVAL_HOURS;
  assert.equal(await drills.sweepDrills(Date.now()), false, 'off by default');

  process.env.RECOVERY_DRILL_INTERVAL_HOURS = '1';
  assert.equal(
    await drills.sweepDrills(Date.now()),
    false,
    'a recent drill keeps the interval clock running'
  );

  // Age every prior drill beyond the interval; the sweep must fire.
  database
    .prepare('UPDATE recovery_drills SET started_at = started_at - 7200000')
    .run();
  assert.equal(await drills.sweepDrills(Date.now()), true);
  let scheduled = null;
  for (let attempt = 0; attempt < 300; attempt++) {
    const listed = await drills.listDrills();
    scheduled = listed.find(
      drill => drill.origin === 'scheduled' && drill.status !== 'running'
    );
    if (scheduled) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(scheduled, 'the sweep started a drill');
  assert.equal(scheduled.status, 'passed');
  delete process.env.RECOVERY_DRILL_INTERVAL_HOURS;
});

test('the team profile refuses filesystem drills and points at the team CLI', async () => {
  process.env.DATABASE_BACKEND = 'postgres';
  try {
    assert.equal(drills.drillsSupported(), false);
    await assert.rejects(
      () => drills.runDrill({ origin: 'manual', createdBy: ADMIN }),
      /team profile/
    );
    assert.equal(await drills.sweepDrills(Date.now()), false);
  } finally {
    process.env.DATABASE_BACKEND = 'sqlite';
  }
});
