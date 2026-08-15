/*
 * Security audit log.
 *
 * Covers: transactional audit rows for group and grant mutations (including
 * rollback leaving no trace), detail redaction (secret keys, long strings,
 * oversized payloads), one-way IP hashing, query filters and limits, and
 * recordAuditEvent's never-throw contract.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-audit-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'security-audit-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [
  { authService },
  audit,
  groups,
  grants,
  { userModel },
  { getPersistence },
  { encryptionService },
  database,
] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('services/securityAuditService.js'),
  importBuilt('services/groupService.js'),
  importBuilt('services/resourceGrantService.js'),
  importBuilt('models/userModel.js'),
  importBuilt('persistence/index.js'),
  importBuilt('services/encryptionService.js'),
  importBuilt('db.js'),
]);

let admin;
let adminActor;
let member;

test.after(() => {
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('setup: accounts and one note to share', async () => {
  const bootstrap = await authService.signup(
    'audit_admin',
    'Audit-Test-Password-1!',
    'audit@example.test',
    { kind: 'signup' }
  );
  assert.equal(bootstrap?.status, 'authenticated');
  admin = bootstrap.user;
  adminActor = { userId: admin.id, role: 'admin', status: 'active' };

  const signup = await authService.signup(
    'audit_member',
    'Audit-Member-Password-1!',
    'audit-member@example.test',
    { kind: 'signup' }
  );
  await userModel.approveUser(signup.user.id, admin.id);
  member = await userModel.getUserById(signup.user.id);

  await getPersistence(
    encryptionService
  ).repositories.resources.notes.replaceWithLimit(
    {
      id: 'audit-note-1',
      user_id: admin.id,
      title: 'audited note',
      content: 'contents',
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    100
  );
});

test('group and grant mutations write audit rows atomically', async () => {
  const group = await groups.createGroup({ name: 'audit-team' }, admin.id);
  await groups.addGroupMember(group.id, member.id, admin.id);
  const grant = await grants.createGrant(adminActor, {
    resourceType: 'note',
    resourceId: 'audit-note-1',
    principalType: 'group',
    principalId: group.id,
    permission: 'read',
  });
  await groups.removeGroupMember(group.id, member.id, admin.id);
  await grants.deleteGrant(adminActor, grant.id);

  const expectations = [
    ['group.create', 'group', group.id],
    ['group.member-add', 'group', group.id],
    ['grant.create', 'note', 'audit-note-1'],
    ['group.member-remove', 'group', group.id],
    ['grant.delete', 'note', 'audit-note-1'],
  ];
  for (const [action, targetType, targetId] of expectations) {
    const rows = await audit.queryAuditEvents({ action, limit: 50 });
    const row = rows.find(
      entry => entry.target_type === targetType && entry.target_id === targetId
    );
    assert.ok(row, `${action} recorded`);
    assert.equal(row.actor_user_id, admin.id);
    assert.equal(row.result, 'success');
  }
});

test('a rolled-back duplicate group create leaves no audit row', async () => {
  const before = await audit.queryAuditEvents({
    action: 'group.create',
    limit: 500,
  });
  await assert.rejects(
    () => groups.createGroup({ name: 'audit-team' }, admin.id),
    error => error.statusCode === 409
  );
  const after = await audit.queryAuditEvents({
    action: 'group.create',
    limit: 500,
  });
  assert.equal(
    after.length,
    before.length,
    'failed mutation added no group.create row'
  );
});

test('redactAuditDetails drops secret-like keys', () => {
  const serialized = audit.redactAuditDetails({
    password: 'hunter2',
    apiToken: 'lwk_secret-value',
    clientSecret: 'shh',
    authorization: 'Bearer abc',
    encryptionKey: 'ff00',
    kept: 'visible-value',
    nested: { jwt: 'ey.abc.def', safe: 'also-visible' },
  });
  assert.ok(serialized);
  assert.ok(!serialized.includes('hunter2'));
  assert.ok(!serialized.includes('lwk_secret-value'));
  assert.ok(!serialized.includes('shh'));
  assert.ok(!serialized.includes('Bearer abc'));
  assert.ok(!serialized.includes('ff00'));
  assert.ok(!serialized.includes('ey.abc.def'));
  assert.ok(serialized.includes('visible-value'));
  assert.ok(serialized.includes('also-visible'));
});

test('redactAuditDetails truncates long strings and caps payload size', () => {
  const longString = 'a'.repeat(1000);
  const serialized = audit.redactAuditDetails({ message: longString });
  const parsed = JSON.parse(serialized);
  assert.ok(parsed.message.length < longString.length);
  assert.ok(parsed.message.startsWith('a'.repeat(256)));
  assert.ok(parsed.message.endsWith('…'), 'truncation is marked');

  const oversized = {};
  for (let index = 0; index < 200; index += 1) {
    oversized[`field_${index}`] = 'x'.repeat(100);
  }
  assert.equal(
    audit.redactAuditDetails(oversized),
    JSON.stringify({ truncated: true }),
    'oversized payloads collapse to a marker'
  );

  assert.equal(audit.redactAuditDetails(undefined), null);
  assert.equal(audit.redactAuditDetails({}), null);
  assert.equal(audit.redactAuditDetails({ password: 'x' }), null);
});

test('hashClientIp is stable, one-way, and null-safe', () => {
  const first = audit.hashClientIp('198.51.100.23');
  const second = audit.hashClientIp('198.51.100.23');
  assert.equal(first, second, 'same input hashes identically');
  assert.notEqual(first, audit.hashClientIp('198.51.100.24'));
  assert.ok(!first.includes('198.51.100.23'), 'raw IP never stored');
  assert.match(first, /^[0-9a-f]{32}$/);
  assert.equal(audit.hashClientIp(undefined), null);
  assert.equal(audit.hashClientIp(''), null);
});

test('queryAuditEvents filters by action, result, and actor, and respects limit', async () => {
  await audit.recordAuditEvent({
    action: 'test.filter',
    result: 'denied',
    actorUserId: member.id,
  });
  await audit.recordAuditEvent({
    action: 'test.filter',
    result: 'success',
    actorUserId: admin.id,
  });
  await audit.recordAuditEvent({
    action: 'test.other',
    result: 'success',
    actorUserId: admin.id,
  });

  const byAction = await audit.queryAuditEvents({
    action: 'test.filter',
    limit: 50,
  });
  assert.equal(byAction.length, 2);
  assert.ok(byAction.every(row => row.action === 'test.filter'));

  const denied = await audit.queryAuditEvents({
    action: 'test.filter',
    result: 'denied',
    limit: 50,
  });
  assert.equal(denied.length, 1);
  assert.equal(denied[0].actor_user_id, member.id);

  const byActor = await audit.queryAuditEvents({
    actorUserId: admin.id,
    limit: 500,
  });
  assert.ok(byActor.length >= 2);
  assert.ok(byActor.every(row => row.actor_user_id === admin.id));

  const limited = await audit.queryAuditEvents({ limit: 1 });
  assert.equal(limited.length, 1);
});

test('recordAuditEvent never throws, even with absurd input', async () => {
  const circular = { name: 'loop' };
  circular.self = circular;
  const absurdInputs = [
    { action: 'test.absurd', result: 'success', details: circular },
    {
      action: 'test.absurd',
      result: 'success',
      details: { big: 'x'.repeat(1_000_000), value: 10n },
    },
    { action: 'test.absurd', result: 'not-a-real-result' },
    { action: '', result: 'success', actorUserId: null },
    {
      action: 'test.absurd',
      result: 'success',
      details: { fn: () => 'nope', sym: Symbol('x'), undef: undefined },
    },
  ];
  for (const input of absurdInputs) {
    await assert.doesNotReject(() => audit.recordAuditEvent(input));
  }
});
