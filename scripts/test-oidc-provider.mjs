/*
 * Generic OIDC sign-in against a local in-process identity provider.
 *
 * A minimal IdP (discovery, JWKS, token endpoint) runs on 127.0.0.1 and
 * signs RS256 ID tokens. Covers: configuration detection, the authorization
 * URL (PKCE S256, state, nonce), code exchange, full ID-token verification
 * (signature, audience, nonce), claim processing (account creation, stable
 * sub linking, email-domain policy, email collisions, admin-group role
 * mapping, group sync), and the state/PKCE cookie roundtrip.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-oidc-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'oidc-provider-test-secret-that-is-long-enough';
process.env.ENABLE_SIGNUP = 'true';
for (const key of Object.keys(process.env)) {
  if (key.startsWith('OIDC_')) delete process.env[key];
}

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [
  { oidcOAuthService, OidcError },
  oauthSecurity,
  { authService },
  groupService,
  { userModel },
  { getPersistence },
  { encryptionService },
  database,
] = await Promise.all([
  importBuilt('services/simpleOidcOAuth.js'),
  importBuilt('services/oauthSecurity.js'),
  importBuilt('services/authService.js'),
  importBuilt('services/groupService.js'),
  importBuilt('models/userModel.js'),
  importBuilt('persistence/index.js'),
  importBuilt('services/encryptionService.js'),
  importBuilt('db.js'),
]);

// --- Local identity provider -------------------------------------------------

const KID = 'test-key-1';
const CLIENT_ID = 'libre-test-client';
const goodKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const rogueKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const goodJwk = {
  ...createPublicKey(goodKeys.privateKey).export({ format: 'jwk' }),
  kid: KID,
  use: 'sig',
  alg: 'RS256',
};

let issuer;
let idTokenForExchange = null;
const idp = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', issuer);
  const json = body => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === '/.well-known/openid-configuration') {
    json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    });
  } else if (url.pathname === '/jwks') {
    json({ keys: [goodJwk] });
  } else if (url.pathname === '/token' && req.method === 'POST') {
    req.resume();
    req.on('end', () =>
      json({ id_token: idTokenForExchange, token_type: 'Bearer' })
    );
  } else {
    res.writeHead(404).end();
  }
});
await new Promise(resolve => idp.listen(0, '127.0.0.1', resolve));
issuer = `http://127.0.0.1:${idp.address().port}`;

const signIdToken = (claims, { key = goodKeys.privateKey, ...options } = {}) =>
  jwt.sign(claims, key, {
    algorithm: 'RS256',
    keyid: KID,
    audience: CLIENT_ID,
    issuer,
    expiresIn: '5m',
    ...options,
  });

const withEnv = async (overrides, fn) => {
  const saved = {};
  for (const [key, value] of Object.entries(overrides)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const rejectsWithOidcCode = (fn, code) =>
  assert.rejects(fn, error => {
    assert.ok(error instanceof OidcError, 'throws OidcError');
    assert.equal(error.code, code);
    return true;
  });

let admin;

test.after(async () => {
  await new Promise(resolve => idp.close(resolve));
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('isConfigured is false until the OIDC environment is set', () => {
  assert.equal(oidcOAuthService.isConfigured(), false);

  process.env.OIDC_ISSUER_URL = issuer;
  process.env.OIDC_CLIENT_ID = CLIENT_ID;
  process.env.OIDC_CLIENT_SECRET = 'test-client-secret';
  process.env.OIDC_CALLBACK_URL =
    'http://localhost:3001/api/auth/oauth/oidc/callback';
  assert.equal(oidcOAuthService.isConfigured(), true);
});

test('setup: bootstrap local admin', async () => {
  const bootstrap = await authService.signup(
    'oidc_local_admin',
    'Oidc-Test-Password-1!',
    'root@local.test',
    { kind: 'signup' }
  );
  assert.equal(bootstrap?.status, 'authenticated');
  admin = bootstrap.user;
});

test('discovery works and the issuer matches the served origin', async () => {
  const document = await oidcOAuthService.discover();
  assert.equal(document.issuer, issuer);
  assert.equal(document.jwks_uri, `${issuer}/jwks`);
  assert.equal(document.token_endpoint, `${issuer}/token`);
});

test('getAuthUrl carries state, nonce, and the S256 PKCE challenge', async () => {
  const { verifier, challenge } = oidcOAuthService.createPkcePair();
  assert.equal(
    challenge,
    createHash('sha256').update(verifier).digest('base64url'),
    'challenge is S256 of the verifier'
  );
  const nonce = oidcOAuthService.createNonce();
  const state = 'state-value-123';

  const authUrl = new URL(
    await oidcOAuthService.getAuthUrl(state, nonce, challenge)
  );
  assert.equal(authUrl.origin, issuer);
  assert.equal(authUrl.pathname, '/authorize');
  assert.equal(authUrl.searchParams.get('state'), state);
  assert.equal(authUrl.searchParams.get('nonce'), nonce);
  assert.equal(authUrl.searchParams.get('code_challenge'), challenge);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
});

test('exchangeCode returns the ID token minted by the token endpoint', async () => {
  idTokenForExchange = signIdToken({ sub: 'exchange-sub', nonce: 'n-1' });
  const exchanged = await oidcOAuthService.exchangeCode('any-code', 'verifier');
  assert.equal(exchanged.idToken, idTokenForExchange);
});

test('verifyIdToken accepts a good token and returns its claims', async () => {
  const token = signIdToken({
    sub: 'verify-sub',
    email: 'verify@corp.example',
    email_verified: true,
    preferred_username: 'verify',
    nonce: 'expected-nonce',
    groups: ['engineers'],
  });
  const claims = await oidcOAuthService.verifyIdToken(token, 'expected-nonce');
  assert.equal(claims.sub, 'verify-sub');
  assert.equal(claims.email, 'verify@corp.example');
  assert.equal(claims.aud, CLIENT_ID);
  assert.equal(claims.iss, issuer);
  assert.deepEqual(claims.groups, ['engineers']);
});

test('verifyIdToken rejects a wrong nonce', async () => {
  const token = signIdToken({ sub: 'verify-sub', nonce: 'expected-nonce' });
  await rejectsWithOidcCode(
    () => oidcOAuthService.verifyIdToken(token, 'a-different-nonce'),
    'nonce-mismatch'
  );
});

test('verifyIdToken rejects a token signed by a different key', async () => {
  const forged = signIdToken(
    { sub: 'verify-sub', nonce: 'expected-nonce' },
    { key: rogueKeys.privateKey }
  );
  await rejectsWithOidcCode(
    () => oidcOAuthService.verifyIdToken(forged, 'expected-nonce'),
    'id-token-invalid'
  );
});

test('verifyIdToken rejects a wrong audience', async () => {
  const token = signIdToken(
    { sub: 'verify-sub', nonce: 'expected-nonce' },
    { audience: 'some-other-client' }
  );
  await rejectsWithOidcCode(
    () => oidcOAuthService.verifyIdToken(token, 'expected-nonce'),
    'id-token-invalid'
  );
});

test('processClaims creates an oidc_* user with a linked identity', async () => {
  const user = await oidcOAuthService.processClaims({
    sub: 'stable-sub-1',
    email: 'alice@corp.example',
    email_verified: true,
    preferred_username: 'alice',
  });
  assert.ok(user.username.startsWith('oidc_alice'));
  assert.equal(user.email, 'alice@corp.example');
  assert.equal(user.role, 'user');

  const identity = await getPersistence(
    encryptionService
  ).repositories.security.oauthIdentities.find('oidc', 'stable-sub-1');
  assert.ok(identity, 'oauth_identities row exists');
  assert.equal(identity.user_id, user.id);
  assert.equal(identity.email, 'alice@corp.example');

  // Approve so later logins can sync roles and groups.
  await userModel.approveUser(user.id, admin.id);
});

test('a second login with the same sub returns the same user despite a rename', async () => {
  const first = await getPersistence(
    encryptionService
  ).repositories.security.oauthIdentities.find('oidc', 'stable-sub-1');
  const user = await oidcOAuthService.processClaims({
    sub: 'stable-sub-1',
    email: 'alice@corp.example',
    email_verified: true,
    preferred_username: 'alice-renamed',
  });
  assert.equal(user.id, first.user_id, 'linked by sub, not username');
  assert.ok(user.username.startsWith('oidc_alice'));
  assert.ok(!user.username.includes('renamed'));
});

test('OIDC_ALLOWED_EMAIL_DOMAINS blocks foreign domains and unverified email', async () => {
  await withEnv({ OIDC_ALLOWED_EMAIL_DOMAINS: 'corp.example' }, async () => {
    await rejectsWithOidcCode(
      () =>
        oidcOAuthService.processClaims({
          sub: 'outsider-sub',
          email: 'mallory@elsewhere.example',
          email_verified: true,
          preferred_username: 'mallory',
        }),
      'email-domain-denied'
    );
    await rejectsWithOidcCode(
      () =>
        oidcOAuthService.processClaims({
          sub: 'unverified-sub',
          email: 'unverified@corp.example',
          email_verified: false,
          preferred_username: 'unverified',
        }),
      'email-domain-denied'
    );
    // A verified, in-domain email still passes.
    const allowed = await oidcOAuthService.processClaims({
      sub: 'in-domain-sub',
      email: 'indomain@corp.example',
      email_verified: true,
      preferred_username: 'indomain',
    });
    assert.ok(allowed.username.startsWith('oidc_indomain'));
  });
});

test('an email owned by a local account is refused, never silently merged', async () => {
  const local = await authService.signup(
    'local_collide',
    'Oidc-Collide-Password-1!',
    'collide@corp.example',
    { kind: 'signup' }
  );
  assert.ok(local);
  await rejectsWithOidcCode(
    () =>
      oidcOAuthService.processClaims({
        sub: 'collider-sub',
        email: 'collide@corp.example',
        email_verified: true,
        preferred_username: 'collider',
      }),
    'email-in-use'
  );
});

test('OIDC_ADMIN_GROUPS promotes and demotes based on the groups claim', async () => {
  await withEnv({ OIDC_ADMIN_GROUPS: 'platform-admins' }, async () => {
    const promoted = await oidcOAuthService.processClaims({
      sub: 'stable-sub-1',
      email: 'alice@corp.example',
      email_verified: true,
      preferred_username: 'alice',
      groups: ['platform-admins', 'engineers'],
    });
    assert.equal(promoted.role, 'admin', 'claim membership grants admin');

    const demoted = await oidcOAuthService.processClaims({
      sub: 'stable-sub-1',
      email: 'alice@corp.example',
      email_verified: true,
      preferred_username: 'alice',
      groups: ['engineers'],
    });
    assert.equal(demoted.role, 'user', 'losing the claim removes admin');
  });
});

test('OIDC_SYNC_GROUPS reconciles Libre group membership with the claim', async () => {
  const group = await groupService.createGroup({ name: 'engineers' }, admin.id);
  const identity = await getPersistence(
    encryptionService
  ).repositories.security.oauthIdentities.find('oidc', 'stable-sub-1');
  const memberships = () =>
    getPersistence(
      encryptionService
    ).repositories.security.groups.listGroupIdsForUser(identity.user_id);

  await withEnv({ OIDC_SYNC_GROUPS: 'true' }, async () => {
    await oidcOAuthService.processClaims({
      sub: 'stable-sub-1',
      email: 'alice@corp.example',
      email_verified: true,
      groups: ['engineers'],
    });
    assert.deepEqual(await memberships(), [group.id], 'claim adds membership');

    await oidcOAuthService.processClaims({
      sub: 'stable-sub-1',
      email: 'alice@corp.example',
      email_verified: true,
      groups: [],
    });
    assert.deepEqual(await memberships(), [], 'missing claim removes it');
  });
});

test('state and PKCE payload roundtrip through the flow cookie', () => {
  const jar = new Map();
  const res = {
    cookie(name, value) {
      jar.set(name, value);
    },
    clearCookie(name) {
      jar.delete(name);
    },
  };
  const requestWithCookies = () => ({
    secure: false,
    protocol: 'http',
    headers: {
      cookie: [...jar.entries()]
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join('; '),
    },
  });

  const { verifier } = oidcOAuthService.createPkcePair();
  const nonce = oidcOAuthService.createNonce();

  const state = oauthSecurity.beginOAuthFlowWithPayload(
    requestWithCookies(),
    res,
    'oidc',
    { verifier, nonce }
  );
  assert.ok(jar.size === 1, 'flow cookie set');

  const payload = oauthSecurity.consumeOAuthStatePayload(
    requestWithCookies(),
    res,
    'oidc',
    state
  );
  assert.deepEqual(payload, { verifier, nonce });
  assert.equal(jar.size, 0, 'cookie cleared: the callback cannot be replayed');

  // A wrong state yields null, and the cookie is still consumed.
  const secondState = oauthSecurity.beginOAuthFlowWithPayload(
    requestWithCookies(),
    res,
    'oidc',
    { verifier, nonce }
  );
  assert.notEqual(secondState, state);
  const mismatch = oauthSecurity.consumeOAuthStatePayload(
    requestWithCookies(),
    res,
    'oidc',
    'attacker-supplied-state'
  );
  assert.equal(mismatch, null);
  assert.equal(jar.size, 0);
});
