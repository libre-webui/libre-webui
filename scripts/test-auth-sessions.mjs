/*
 * Server-side auth sessions bound to JWTs.
 *
 * Covers: signup issuing a sid-bound token backed by an auth_sessions row,
 * middleware acceptance, single-session revocation, revoke-others sparing the
 * current session, legacy (sid-less) tokens and the invalid-before epoch,
 * session listing with revocation metadata, and revocation listeners.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-auth-sessions-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'auth-sessions-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [{ authService }, { authenticate }, sessions, database] =
  await Promise.all([
    importBuilt('services/authService.js'),
    importBuilt('middleware/auth.js'),
    importBuilt('services/authSessionService.js'),
    importBuilt('db.js'),
  ]);

const decodePayload = token =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());

const callAuthenticate = (token, requestPath = '/api/chat/sessions') =>
  new Promise(resolve => {
    const req = {
      headers: { authorization: token ? `Bearer ${token}` : undefined },
      originalUrl: requestPath,
    };
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
    authenticate(req, res, () => resolve({ req, status: 200, body: null }));
  });

const password = 'Sessions-Test-Password-1!';
let admin;
let bootstrapToken;
let bootstrapSid;

test.after(() => {
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('signup bootstrap issues a sid-bound token with an auth_sessions row', async () => {
  const result = await authService.signup(
    'session_admin',
    password,
    'sessions@example.test',
    { kind: 'signup', ip: '203.0.113.7', userAgent: 'node-test' }
  );
  assert.equal(result?.status, 'authenticated');
  admin = result.user;
  bootstrapToken = result.token;

  const payload = decodePayload(bootstrapToken);
  assert.ok(payload.sid, 'JWT carries a sid claim');
  bootstrapSid = payload.sid;

  const record = await sessions.findSessionById(bootstrapSid);
  assert.ok(record, 'auth_sessions row exists for the sid');
  assert.equal(record.user_id, admin.id);
  assert.equal(record.kind, 'signup');
  assert.equal(record.revoked_at, null);
  assert.ok(record.expires_at > Date.now(), 'session expires in the future');
  assert.ok(record.ip_hash, 'ip stored only as a hash');
  assert.ok(!String(record.ip_hash).includes('203.0.113.7'));
});

test('authenticate accepts the sid token and reports a session auth kind', async () => {
  const outcome = await callAuthenticate(bootstrapToken);
  assert.equal(outcome.status, 200);
  assert.equal(outcome.req.auth?.kind, 'session');
  assert.equal(outcome.req.auth?.sessionId, bootstrapSid);
  assert.equal(outcome.req.user?.userId, admin.id);
});

test('revoking the session rejects its token with 401', async () => {
  assert.equal(await sessions.revokeAuthSession(bootstrapSid, admin.id), true);
  assert.equal(await sessions.getValidSession(bootstrapSid), null);
  const outcome = await callAuthenticate(bootstrapToken);
  assert.equal(outcome.status, 401);
});

test('revoke-others spares the current session and kills the rest', async () => {
  const keep = await authService.login('session_admin', password);
  const drop = await authService.login('session_admin', password);
  assert.equal(keep?.status, 'authenticated');
  assert.equal(drop?.status, 'authenticated');
  const keepSid = decodePayload(keep.token).sid;
  const dropSid = decodePayload(drop.token).sid;

  const revoked = await sessions.revokeAllAuthSessions(
    admin.id,
    admin.id,
    keepSid
  );
  assert.ok(revoked.includes(dropSid), 'other session id reported revoked');
  assert.ok(!revoked.includes(keepSid), 'current session id spared');

  assert.equal((await callAuthenticate(keep.token)).status, 200);
  assert.equal((await callAuthenticate(drop.token)).status, 401);
});

test('legacy sid-less tokens work until the revoke-all epoch passes', async () => {
  const login = await authService.login('session_admin', password);
  const legacyToken = authService.generateToken(login.user);
  assert.equal(decodePayload(legacyToken).sid, undefined);

  let outcome = await callAuthenticate(legacyToken);
  assert.equal(outcome.status, 200, 'legacy token accepted before epoch');
  assert.equal(outcome.req.auth?.kind, 'legacy-token');

  // Ensure the revocation epoch lands strictly after the token's iat second.
  await new Promise(resolve => setTimeout(resolve, 5));
  await sessions.revokeAllAuthSessions(admin.id, admin.id);
  const epoch = await sessions.getTokenInvalidBefore(admin.id);
  assert.ok(epoch > 0, 'invalid-before epoch stamped');
  assert.ok(decodePayload(legacyToken).iat * 1000 < epoch);

  outcome = await callAuthenticate(legacyToken);
  assert.equal(outcome.status, 401, 'legacy token rejected after epoch');
});

test('listSessionsForUser exposes revocation metadata', async () => {
  const rows = await sessions.listSessionsForUser(admin.id);
  assert.ok(rows.length >= 4, 'all issued sessions listed');
  const revokedRows = rows.filter(row => row.revoked_at !== null);
  assert.ok(revokedRows.length >= 4, 'revoked sessions carry revoked_at');
  assert.ok(revokedRows.every(row => row.revoked_by === admin.id));
  const bootstrapRow = rows.find(row => row.id === bootstrapSid);
  assert.ok(bootstrapRow?.revoked_at !== null);
});

test('revocation listeners fire with the revoked session ids', async () => {
  const login = await authService.login('session_admin', password);
  const sid = decodePayload(login.token).sid;

  const events = [];
  const unsubscribe = sessions.registerSessionRevocationListener(event =>
    events.push(event)
  );
  try {
    await sessions.revokeAuthSession(sid, admin.id);
  } finally {
    unsubscribe();
  }

  assert.equal(events.length, 1);
  assert.equal(events[0].userId, admin.id);
  assert.deepEqual(events[0].sessionIds, [sid]);
  assert.equal(events[0].version, 1);

  // Unsubscribed listeners stay silent.
  const again = await authService.login('session_admin', password);
  await sessions.revokeAuthSession(decodePayload(again.token).sid, admin.id);
  assert.equal(events.length, 1);
});
