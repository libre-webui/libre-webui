/*
 * Central authorization service: the policy matrix over one shared note.
 *
 * Covers: ownership, default privacy, direct and group grants, immediate
 * revocation on membership removal, permission upgrades, inactive-account
 * denial, feature gates (admin default + work access mode), the effective
 * access explainer, non-existent resources, and non-enumerating grant
 * listings for non-managers.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-authz-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'authorization-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [
  { authService },
  authz,
  groups,
  grants,
  work,
  { userModel },
  { getPersistence },
  { encryptionService },
  database,
] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('services/authorizationService.js'),
  importBuilt('services/groupService.js'),
  importBuilt('services/resourceGrantService.js'),
  importBuilt('services/workAccessService.js'),
  importBuilt('models/userModel.js'),
  importBuilt('persistence/index.js'),
  importBuilt('services/encryptionService.js'),
  importBuilt('db.js'),
]);

const NOTE_ID = 'authz-note-1';
let admin;
let bob;
let bobActor;
let adminActor;
let group;

const note = () => ({ type: 'note', id: NOTE_ID });

test.after(() => {
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('setup: admin owner, approved member, and one note', async () => {
  const bootstrap = await authService.signup(
    'authz_admin',
    'Authz-Test-Password-1!',
    'authz@example.test',
    { kind: 'signup' }
  );
  assert.equal(bootstrap?.status, 'authenticated');
  admin = bootstrap.user;
  adminActor = { userId: admin.id, role: 'admin', status: 'active' };

  const signup = await authService.signup(
    'authz_bob',
    'Authz-Bob-Password-1!',
    'authz-bob@example.test',
    { kind: 'signup' }
  );
  assert.equal(signup?.status, 'pending');
  await userModel.approveUser(signup.user.id, admin.id);
  bob = await userModel.getUserById(signup.user.id);
  bobActor = { userId: bob.id, role: bob.role, status: bob.status };

  const persistence = getPersistence(encryptionService);
  await persistence.repositories.resources.notes.replaceWithLimit(
    {
      id: NOTE_ID,
      user_id: admin.id,
      title: 'shared policy note',
      content: 'contents',
      created_at: Date.now(),
      updated_at: Date.now(),
    },
    100
  );
});

test('owner is allowed; unrelated users are denied by default', async () => {
  let decision = await authz.authorize(adminActor, 'write', note());
  assert.deepEqual(decision, { allowed: true, reason: 'owner' });

  decision = await authz.authorize(bobActor, 'read', note());
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-grant');
});

test('a direct user grant allows read but not write', async () => {
  await grants.createGrant(adminActor, {
    resourceType: 'note',
    resourceId: NOTE_ID,
    principalType: 'user',
    principalId: bob.id,
    permission: 'read',
  });

  let decision = await authz.authorize(bobActor, 'read', note());
  assert.deepEqual(decision, { allowed: true, reason: 'direct-grant' });

  decision = await authz.authorize(bobActor, 'write', note());
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'insufficient-permission');
});

test('upgrading the grant to write allows write', async () => {
  await grants.createGrant(adminActor, {
    resourceType: 'note',
    resourceId: NOTE_ID,
    principalType: 'user',
    principalId: bob.id,
    permission: 'write',
  });
  const decision = await authz.authorize(bobActor, 'write', note());
  assert.equal(decision.allowed, true);
});

test('group grants reach members and die with the membership', async () => {
  // Clear bob's direct grants so only the group path remains.
  const rows = await grants.listGrantsForResource(adminActor, 'note', NOTE_ID);
  for (const row of rows) {
    assert.equal(await grants.deleteGrant(adminActor, row.id), true);
  }
  let decision = await authz.authorize(bobActor, 'read', note());
  assert.equal(decision.allowed, false, 'clean slate before group grant');

  group = await groups.createGroup(
    { name: 'authz-team', description: 'policy matrix team' },
    admin.id
  );
  await grants.createGrant(adminActor, {
    resourceType: 'note',
    resourceId: NOTE_ID,
    principalType: 'group',
    principalId: group.id,
    permission: 'read',
  });

  decision = await authz.authorize(bobActor, 'read', note());
  assert.equal(decision.allowed, false, 'not a member yet');

  await groups.addGroupMember(group.id, bob.id, admin.id);
  assert.deepEqual(await authz.resolveGroupIdsForUser(bob.id), [group.id]);
  decision = await authz.authorize(bobActor, 'read', note());
  assert.deepEqual(decision, { allowed: true, reason: 'group-grant' });

  await groups.removeGroupMember(group.id, bob.id, admin.id);
  decision = await authz.authorize(bobActor, 'read', note());
  assert.equal(decision.allowed, false, 'removal revokes immediately');

  // Restore membership for the explainer test below.
  await groups.addGroupMember(group.id, bob.id, admin.id);
});

test('a pending-status actor is denied everything', async () => {
  const pendingActor = { userId: admin.id, role: 'admin', status: 'pending' };
  for (const action of ['read', 'write', 'manage', 'use']) {
    const decision = await authz.authorize(pendingActor, action, note());
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'inactive-account');
  }
  const feature = await authz.authorize(pendingActor, 'use', {
    type: 'feature',
    id: 'work',
  });
  assert.equal(feature.allowed, false);
  assert.equal(feature.reason, 'inactive-account');
});

test('feature gates default to admins only', async () => {
  for (const id of ['work', 'model-download', 'web-search']) {
    const adminDecision = await authz.authorize(adminActor, 'use', {
      type: 'feature',
      id,
    });
    assert.equal(adminDecision.allowed, true, `admin allowed for ${id}`);
    assert.equal(adminDecision.reason, 'admin-role');

    const userDecision = await authz.authorize(bobActor, 'use', {
      type: 'feature',
      id,
    });
    assert.equal(userDecision.allowed, false, `non-admin denied for ${id}`);
    assert.equal(userDecision.reason, 'feature-restricted-to-admins');
  }
});

test('work access mode all-users opens the gate, in step with userHasWorkAccess', async () => {
  assert.equal(await work.userHasWorkAccess(bob), false);

  await work.setWorkAccessMode('all-users');
  try {
    const decision = await authz.authorize(bobActor, 'use', {
      type: 'feature',
      id: 'work',
    });
    assert.equal(decision.allowed, true);
    assert.equal(decision.reason, 'feature-open-to-all-users');
    assert.equal(
      await work.userHasWorkAccess(bob),
      true,
      'userHasWorkAccess agrees with authorize'
    );
  } finally {
    await work.setWorkAccessMode('admins');
  }

  const closed = await authz.authorize(bobActor, 'use', {
    type: 'feature',
    id: 'work',
  });
  assert.equal(closed.allowed, false);
  assert.equal(await work.userHasWorkAccess(bob), false);
});

test('explainEffectiveAccess returns groups, feature booleans, and grants', async () => {
  const view = await authz.explainEffectiveAccess({
    id: bob.id,
    role: bob.role,
    status: bob.status,
  });
  assert.equal(view.userId, bob.id);
  assert.deepEqual(
    view.groups.map(entry => entry.name),
    ['authz-team']
  );
  assert.deepEqual(view.features, {
    work: false,
    'model-download': false,
    'web-search': false,
    agents: view.features.agents,
  });
  assert.equal(typeof view.features.agents, 'boolean');
  const groupGrant = view.grants.find(
    entry => entry.via === 'group' && entry.resourceId === NOTE_ID
  );
  assert.ok(groupGrant, 'group grant surfaces in the explainer');
  assert.equal(groupGrant.permission, 'read');
  assert.equal(groupGrant.principalId, group.id);
});

test('an unknown resource id is denied as resource-not-found', async () => {
  const decision = await authz.authorize(adminActor, 'read', {
    type: 'note',
    id: 'no-such-note',
  });
  assert.deepEqual(decision, { allowed: false, reason: 'resource-not-found' });
});

test('listing grants as a non-manager fails with a non-enumerating 404', async () => {
  await assert.rejects(
    () => grants.listGrantsForResource(bobActor, 'note', NOTE_ID),
    error => {
      assert.equal(error.name, 'ResourceGrantError');
      assert.equal(error.statusCode, 404);
      return true;
    }
  );
  // The same shape for a resource that truly does not exist: no oracle.
  await assert.rejects(
    () => grants.listGrantsForResource(bobActor, 'note', 'no-such-note'),
    error => error.statusCode === 404
  );
});
