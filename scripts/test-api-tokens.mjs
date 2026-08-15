/*
 * Scoped API tokens (lwk_*).
 *
 * Covers: token format and hashed-at-rest storage, the scope-to-path matrix
 * enforced by the authenticate middleware, admin-scope fallback for unknown
 * route families, expiry, revocation, requireAdmin demanding the admin scope
 * even for admin-role users, and the public projection never leaking hashes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-api-tokens-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'api-tokens-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [
  { authService },
  { authenticate, requireAdmin },
  tokens,
  { getPersistence },
  { encryptionService },
  database,
] = await Promise.all([
  importBuilt('services/authService.js'),
  importBuilt('middleware/auth.js'),
  importBuilt('services/apiTokenService.js'),
  importBuilt('persistence/index.js'),
  importBuilt('services/encryptionService.js'),
  importBuilt('db.js'),
]);

const callMiddleware = (middleware, req) =>
  new Promise(resolve => {
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ req, status: this.statusCode, body });
      },
    };
    middleware(req, res, () => resolve({ req, status: 200, body: null }));
  });

const callAuthenticate = (bearer, requestPath) =>
  callMiddleware(authenticate, {
    headers: { authorization: bearer ? `Bearer ${bearer}` : undefined },
    originalUrl: requestPath,
  });

const tokenRepo = () =>
  getPersistence(encryptionService).repositories.security.apiTokens;

let admin;

test.after(() => {
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('setup: bootstrap an admin account', async () => {
  const result = await authService.signup(
    'token_admin',
    'Tokens-Test-Password-1!',
    'tokens@example.test',
    { kind: 'signup' }
  );
  assert.equal(result?.status, 'authenticated');
  admin = result.user;
});

test('tokens use the lwk_ prefix and are stored only as sha256 hashes', async () => {
  const created = await tokens.createApiToken(admin.id, {
    name: 'format-check',
    scopes: ['notes'],
  });
  assert.ok(created.token.startsWith('lwk_'));
  assert.equal(created.record.token_prefix, created.token.slice(0, 12));

  assert.notEqual(created.record.token_hash, created.token);
  assert.ok(!created.record.token_hash.includes(created.token));
  assert.equal(
    created.record.token_hash,
    tokens.hashApiToken(created.token),
    'stored hash is the sha256 of the plaintext'
  );

  const byHash = await tokenRepo().findByHash(
    tokens.hashApiToken(created.token)
  );
  assert.equal(byHash?.id, created.record.id, 'findByHash resolves the row');
  const byPlaintext = await tokenRepo().findByHash(created.token);
  assert.equal(byPlaintext, null, 'plaintext is not a lookup key');
});

test('scope-to-path matrix: notes scope on notes, chat, and auth routes', async () => {
  const created = await tokens.createApiToken(admin.id, {
    name: 'notes-only',
    scopes: ['notes'],
  });

  let outcome = await callAuthenticate(created.token, '/api/notes/list');
  assert.equal(outcome.status, 200, 'notes scope allows /api/notes');
  assert.equal(outcome.req.auth?.kind, 'api-token');
  assert.equal(outcome.req.auth?.tokenId, created.record.id);
  assert.deepEqual(outcome.req.auth?.scopes, ['notes']);

  outcome = await callAuthenticate(created.token, '/api/chat/sessions');
  assert.equal(outcome.status, 403, 'notes scope blocks /api/chat');

  outcome = await callAuthenticate(created.token, '/api/auth/sessions');
  assert.equal(outcome.status, 403, 'auth routes barred for API tokens');
  assert.equal(outcome.body?.code, 'TOKEN_SCOPE');
});

test('unknown route families require the admin scope', async () => {
  assert.equal(tokens.requiredScopeForPath('/api/brand-new-surface'), 'admin');

  const notesToken = await tokens.createApiToken(admin.id, {
    name: 'notes-vs-unknown',
    scopes: ['notes'],
  });
  let outcome = await callAuthenticate(
    notesToken.token,
    '/api/brand-new-surface'
  );
  assert.equal(outcome.status, 403, 'non-admin scope blocked on unknown path');

  const adminToken = await tokens.createApiToken(admin.id, {
    name: 'admin-scope',
    scopes: ['admin'],
  });
  outcome = await callAuthenticate(adminToken.token, '/api/brand-new-surface');
  assert.equal(outcome.status, 200, 'admin scope passes unknown path');
});

test('expiresInDays is honored and expired tokens stop resolving', async () => {
  const before = Date.now();
  const created = await tokens.createApiToken(admin.id, {
    name: 'short-lived',
    scopes: ['notes'],
    expiresInDays: 7,
  });
  const after = Date.now();
  const sevenDays = 7 * 24 * 60 * 60 * 1000;
  assert.ok(created.record.expires_at >= before + sevenDays);
  assert.ok(created.record.expires_at <= after + sevenDays);
  assert.ok(await tokens.resolveApiToken(created.token), 'valid until expiry');

  // Plant an already-expired row: the resolver must treat it as dead.
  const expiredPlaintext = 'lwk_expired-token-for-test';
  await tokenRepo().insert({
    id: 'expired-token-row',
    user_id: admin.id,
    name: 'already-expired',
    token_hash: tokens.hashApiToken(expiredPlaintext),
    token_prefix: expiredPlaintext.slice(0, 12),
    scopes: JSON.stringify(['notes']),
    created_at: Date.now() - sevenDays,
    expires_at: Date.now() - 1000,
    last_used_at: null,
    revoked_at: null,
  });
  assert.equal(await tokens.resolveApiToken(expiredPlaintext), null);
  const outcome = await callAuthenticate(expiredPlaintext, '/api/notes/list');
  assert.equal(outcome.status, 401, 'expired token rejected by middleware');
});

test('revocation invalidates a token immediately', async () => {
  const created = await tokens.createApiToken(admin.id, {
    name: 'revoke-me',
    scopes: ['notes'],
  });
  assert.equal(
    (await callAuthenticate(created.token, '/api/notes/list')).status,
    200
  );
  assert.equal(await tokens.revokeApiToken(created.record.id), true);
  assert.equal(await tokens.resolveApiToken(created.token), null);
  assert.equal(
    (await callAuthenticate(created.token, '/api/notes/list')).status,
    401
  );
});

test('requireAdmin rejects an admin-role user presenting a token without the admin scope', async () => {
  const created = await tokens.createApiToken(admin.id, {
    name: 'admin-user-notes-token',
    scopes: ['notes'],
  });
  const outcome = await callMiddleware(requireAdmin, {
    user: { userId: admin.id, username: admin.username, role: 'admin' },
    auth: {
      kind: 'api-token',
      tokenId: created.record.id,
      scopes: ['notes'],
    },
  });
  assert.equal(outcome.status, 403);
  assert.equal(outcome.body?.code, 'TOKEN_SCOPE');

  const adminScoped = await tokens.createApiToken(admin.id, {
    name: 'admin-user-admin-token',
    scopes: ['admin'],
  });
  const allowed = await callMiddleware(requireAdmin, {
    user: { userId: admin.id, username: admin.username, role: 'admin' },
    auth: {
      kind: 'api-token',
      tokenId: adminScoped.record.id,
      scopes: ['admin'],
    },
  });
  assert.equal(allowed.status, 200, 'admin scope satisfies requireAdmin');
});

test('toPublicToken never exposes the token hash', async () => {
  const rows = await tokens.listTokensForUser(admin.id);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    const projected = tokens.toPublicToken(row);
    const serialized = JSON.stringify(projected);
    assert.ok(!('token_hash' in projected));
    assert.ok(!serialized.includes(row.token_hash));
    assert.equal(projected.id, row.id);
    assert.equal(projected.tokenPrefix, row.token_prefix);
    assert.ok(Array.isArray(projected.scopes));
  }
});
