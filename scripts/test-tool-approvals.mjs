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
 * Tool approval policy (TOOL-04): pending requests, the waiting generation's
 * decision loop, standing approvals scoped to a chat or to a tool, denial,
 * expiry, revocation, and cancellation.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-tool-approvals-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'tool-approvals-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '4'.repeat(64);

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

const [approvals, database, { getPersistence }] = await Promise.all([
  distModule('services/toolApprovalService.js'),
  distModule('db.js'),
  distModule('persistence/index.js'),
]);

const repository = () =>
  getPersistence(encryptionService).repositories.resources.toolApprovals;

const db = database.getDatabase();
const now = Date.now();

const createUser = id => {
  db.prepare(
    `INSERT INTO users
       (id, username, email, password_hash, role, account_status, avatar,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'unused', 'user', 'active', NULL, ?, ?)`
  ).run(id, id, now, now);
  return id;
};

const createSession = (id, userId) => {
  db.prepare(
    `INSERT INTO sessions (id, user_id, title, model, created_at, updated_at)
     VALUES (?, ?, ?, 'mock-model', ?, ?)`
  ).run(id, userId, `chat ${id}`, now, now);
  return id;
};

const ALICE = createUser('approval-alice');
const BOB = createUser('approval-bob');
const SESSION_A = createSession('approval-session-a', ALICE);
const SESSION_B = createSession('approval-session-b', ALICE);

const SERVER_ID = 'approval-server-1';
db.prepare(
  `INSERT INTO tool_servers
     (id, user_id, name, description, kind, base_url, spec, spec_digest,
      spec_revision, auth_mode, auth_header, access_mode, enabled,
      timeout_ms, max_response_bytes, created_at, updated_at)
   VALUES (?, ?, 'Approval Server', NULL, 'openapi', 'http://example.test',
           NULL, NULL, 1, 'none', NULL, 'admins-only', 1, 30000, 262144, ?, ?)`
).run(SERVER_ID, ALICE, now, now);

after(async () => {
  database.closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

let callCounter = 0;
const pendingFor = (overrides = {}) =>
  approvals.createPendingApproval({
    userId: ALICE,
    sessionId: null,
    serverId: SERVER_ID,
    toolName: 'delete_pet',
    callId: `call-${++callCounter}`,
    argumentsJson: JSON.stringify({ petId: 7 }),
    ...overrides,
  });

// === 1. Create, decide, and wait ===

test('a pending approval is created and resolved exactly once', async () => {
  const pending = await pendingFor();
  assert.equal(pending.status, 'pending');
  assert.equal(pending.scope, 'once');
  assert.equal(pending.toolName, 'delete_pet');
  assert.equal(pending.serverId, SERVER_ID);
  assert.equal(pending.sessionId, undefined);
  assert.ok(pending.expiresAt > Date.now());
  assert.ok(
    pending.expiresAt - pending.createdAt === approvals.APPROVAL_TIMEOUT_MS
  );
  assert.equal(approvals.APPROVAL_TIMEOUT_MS, 120_000);

  const listed = await approvals.listPendingApprovals(ALICE);
  assert.equal(
    listed.some(entry => entry.id === pending.id),
    true
  );

  const decided = await approvals.decideApproval(ALICE, pending.id, {
    approve: true,
    scope: 'always',
  });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.scope, 'always');
  assert.ok(decided.resolvedAt >= decided.createdAt);

  // The argument digest is stored, never the raw arguments.
  const row = db
    .prepare('SELECT * FROM tool_approvals WHERE id = ?')
    .get(pending.id);
  assert.match(row.arguments_digest, /^[0-9a-f]{64}$/);
  assert.equal(
    row.arguments_digest,
    approvals.argumentsDigest(JSON.stringify({ petId: 7 }))
  );

  const stillPending = await approvals.listPendingApprovals(ALICE);
  assert.equal(
    stillPending.some(entry => entry.id === pending.id),
    false
  );
});

test('waitForDecision resolves when the decision lands from elsewhere', async () => {
  const pending = await pendingFor({ toolName: 'restart_service' });
  const waiting = approvals.waitForDecision(ALICE, pending.id);
  const deciding = (async () => {
    await delay(50);
    return approvals.decideApproval(ALICE, pending.id, {
      approve: true,
      scope: 'once',
    });
  })();

  const [resolved, decided] = await Promise.all([waiting, deciding]);
  assert.equal(resolved.status, 'approved');
  assert.equal(resolved.scope, 'once');
  assert.equal(resolved.id, pending.id);
  assert.equal(decided.status, 'approved');

  // A 'once' decision leaves nothing standing behind.
  assert.equal(
    await approvals.findStandingApproval(
      ALICE,
      SERVER_ID,
      'restart_service',
      null
    ),
    null
  );
});

// === 2. Standing approvals ===

test("an 'always' approval stands for that user, server, and tool only", async () => {
  const standing = await approvals.findStandingApproval(
    ALICE,
    SERVER_ID,
    'delete_pet',
    null
  );
  assert.ok(standing, 'the always approval is found');
  assert.equal(standing.scope, 'always');
  assert.equal(standing.status, 'approved');

  // A session id does not narrow an 'always' approval.
  assert.ok(
    await approvals.findStandingApproval(
      ALICE,
      SERVER_ID,
      'delete_pet',
      SESSION_A
    )
  );

  assert.equal(
    await approvals.findStandingApproval(ALICE, SERVER_ID, 'other_tool', null),
    null,
    'a different tool is not covered'
  );
  assert.equal(
    await approvals.findStandingApproval(BOB, SERVER_ID, 'delete_pet', null),
    null,
    'another user is not covered'
  );
  assert.equal(
    await approvals.findStandingApproval(ALICE, null, 'delete_pet', null),
    null,
    'a builtin call is not covered by a server-scoped approval'
  );

  const listed = await approvals.listStandingApprovals(ALICE);
  assert.equal(
    listed.some(entry => entry.id === standing.id),
    true
  );
  assert.equal((await approvals.listStandingApprovals(BOB)).length, 0);
});

// === 3. Session scope ===

test("a 'session' approval binds to the chat it was granted in", async () => {
  const pending = await pendingFor({
    sessionId: SESSION_A,
    toolName: 'send_email',
  });
  assert.equal(pending.sessionId, SESSION_A);

  const decided = await approvals.decideApproval(ALICE, pending.id, {
    approve: true,
    scope: 'session',
  });
  assert.equal(decided.scope, 'session');
  assert.equal(decided.status, 'approved');

  const hit = await approvals.findStandingApproval(
    ALICE,
    SERVER_ID,
    'send_email',
    SESSION_A
  );
  assert.ok(hit, 'the granting chat is covered');
  assert.equal(hit.id, pending.id);

  assert.equal(
    await approvals.findStandingApproval(
      ALICE,
      SERVER_ID,
      'send_email',
      SESSION_B
    ),
    null,
    'another chat is not covered'
  );
  assert.equal(
    await approvals.findStandingApproval(ALICE, SERVER_ID, 'send_email', null),
    null,
    'a private chat is not covered'
  );
});

test("a 'session' decision on a chatless request downgrades to 'once'", async () => {
  const pending = await pendingFor({
    sessionId: null,
    toolName: 'post_message',
  });
  const decided = await approvals.decideApproval(ALICE, pending.id, {
    approve: true,
    scope: 'session',
  });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.scope, 'once', 'no session to bind to');
  assert.equal(
    await approvals.findStandingApproval(
      ALICE,
      SERVER_ID,
      'post_message',
      null
    ),
    null
  );
});

// === 4. Denial ===

test('a denial resolves the request and cannot be decided twice', async () => {
  const pending = await pendingFor({ toolName: 'wipe_disk' });
  const denied = await approvals.decideApproval(ALICE, pending.id, {
    approve: false,
    scope: 'once',
  });
  assert.equal(denied.status, 'denied');

  assert.equal(
    await approvals.decideApproval(ALICE, pending.id, {
      approve: true,
      scope: 'always',
    }),
    null,
    'a resolved request cannot be re-decided'
  );

  const second = await pendingFor({ toolName: 'wipe_disk_2' });
  assert.equal(
    await approvals.decideApproval(BOB, second.id, {
      approve: true,
      scope: 'always',
    }),
    null,
    'only the owner decides'
  );
  assert.equal(
    await approvals.decideApproval(ALICE, 'no-such-approval', {
      approve: true,
      scope: 'once',
    }),
    null
  );

  // The still-pending row survives the stranger's attempt.
  const row = db
    .prepare('SELECT status FROM tool_approvals WHERE id = ?')
    .get(second.id);
  assert.equal(row.status, 'pending');
  await approvals.decideApproval(ALICE, second.id, {
    approve: false,
    scope: 'once',
  });
});

// === 5. Expiry ===

test('an elapsed request expires and drops out of the pending list', async () => {
  const id = 'approval-expired-1';
  await repository().insert({
    id,
    user_id: ALICE,
    session_id: null,
    server_id: SERVER_ID,
    tool_name: 'slow_tool',
    call_id: 'call-expired',
    arguments_digest: approvals.argumentsDigest('{}'),
    scope: 'once',
    status: 'pending',
    created_at: Date.now() - 200_000,
    resolved_at: null,
    expires_at: Date.now() - 1_000,
  });

  const started = Date.now();
  const resolved = await approvals.waitForDecision(ALICE, id);
  assert.equal(resolved.status, 'expired');
  assert.ok(
    Date.now() - started < 5_000,
    'the poll loop expires the row promptly'
  );

  const listed = await approvals.listPendingApprovals(ALICE);
  assert.equal(
    listed.some(entry => entry.id === id),
    false
  );
  assert.equal(
    await approvals.decideApproval(ALICE, id, {
      approve: true,
      scope: 'always',
    }),
    null,
    'an expired request can no longer be approved'
  );
  assert.equal(
    await approvals.findStandingApproval(ALICE, SERVER_ID, 'slow_tool', null),
    null
  );
});

// === 6. Revocation ===

test('revoking a standing approval removes it', async () => {
  const standing = await approvals.findStandingApproval(
    ALICE,
    SERVER_ID,
    'delete_pet',
    null
  );
  assert.ok(standing);

  assert.equal(
    await approvals.revokeApproval(BOB, standing.id),
    false,
    'only the owner revokes'
  );
  assert.equal(await approvals.revokeApproval(ALICE, standing.id), true);
  assert.equal(
    await approvals.findStandingApproval(ALICE, SERVER_ID, 'delete_pet', null),
    null
  );
  assert.equal(await approvals.revokeApproval(ALICE, standing.id), false);
  assert.equal(
    (await approvals.listStandingApprovals(ALICE)).some(
      entry => entry.id === standing.id
    ),
    false
  );
});

// === 7. Cancellation ===

test('waiting with an aborted signal rejects instead of hanging', async () => {
  const pending = await pendingFor({ toolName: 'long_tool' });
  const reason = new Error('generation cancelled');
  await assert.rejects(
    () =>
      approvals.waitForDecision(ALICE, pending.id, AbortSignal.abort(reason)),
    error => {
      assert.equal(error, reason);
      return true;
    }
  );

  const controller = new AbortController();
  const waiting = approvals.waitForDecision(
    ALICE,
    pending.id,
    controller.signal
  );
  const rejected = assert.rejects(() => waiting, /cancelled mid-wait/);
  await delay(20);
  controller.abort(new Error('cancelled mid-wait'));
  await rejected;

  // The request is untouched by the abort and can still be decided.
  const decided = await approvals.decideApproval(ALICE, pending.id, {
    approve: false,
    scope: 'once',
  });
  assert.equal(decided.status, 'denied');
});
