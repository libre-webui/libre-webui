/*
 * IAM-09: TOTP multi-factor authentication and passkeys.
 *
 * Covers: RFC 6238 vectors and base32 round-trips, enrollment/activation,
 * the login-time MFA challenge (issued, verified, one-use, never a session
 * credential), TOTP replay refusal, recovery-code single use, the required
 * step-up policy, admin reset, and a full WebAuthn register + login pass
 * with a real P-256 keypair, plus origin and challenge-reuse rejection.
 */
import assert from 'node:assert/strict';
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-mfa-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'mfa-test-secret-that-is-long-enough-000';
process.env.ENABLE_SIGNUP = 'true';
delete process.env.MFA_REQUIRED_MODE;

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

const [
  totp,
  webauthnUtils,
  { authService },
  { authenticate },
  mfa,
  webauthnService,
  coordination,
  database,
] = await Promise.all([
  importBuilt('utils/totp.js'),
  importBuilt('utils/webauthn.js'),
  importBuilt('services/authService.js'),
  importBuilt('middleware/auth.js'),
  importBuilt('services/mfaService.js'),
  importBuilt('services/webauthnService.js'),
  importBuilt('platform/coordination/service.js'),
  importBuilt('db.js'),
]);

await coordination.initializeCoordinator();

test.after(async () => {
  await coordination.closeCoordinator();
  database.closeDatabase();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const callAuthenticate = token =>
  new Promise(resolve => {
    const req = {
      headers: { authorization: `Bearer ${token}` },
      originalUrl: '/api/chat/sessions',
    };
    const res = {
      statusCode: 200,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        resolve({ status: this.statusCode, body });
      },
    };
    authenticate(req, res, () => resolve({ status: 200, body: null }));
  });

/* ------------------------------------------------------------- TOTP */

test('TOTP implements the RFC 6238 SHA-1 vectors', () => {
  // RFC 6238 Appendix B secret: ASCII "12345678901234567890".
  const secret = totp.encodeBase32(Buffer.from('12345678901234567890', 'utf8'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.deepEqual(
    totp.decodeBase32(secret),
    Buffer.from('12345678901234567890', 'utf8')
  );
  // The RFC publishes 8-digit codes; the 6-digit code is the same dynamic
  // truncation mod 10^6.
  const vectors = [
    [59_000, '287082'],
    [1_111_111_109_000, '081804'],
    [1_234_567_890_000, '005924'],
    [2_000_000_000_000, '279037'],
  ];
  for (const [ms, expected] of vectors) {
    const step = Math.floor(ms / 1000 / 30);
    assert.equal(totp.totpCodeForStep(secret, step), expected);
  }
});

test('TOTP verification accepts the skew window and nothing beyond it', () => {
  const secret = totp.generateTotpSecret();
  const now = 1_700_000_000_000;
  const step = totp.currentTotpStep(now);
  assert.equal(totp.verifyTotpCode(secret, totp.totpCodeForStep(secret, step), now), step);
  assert.equal(
    totp.verifyTotpCode(secret, totp.totpCodeForStep(secret, step - 1), now),
    step - 1
  );
  assert.equal(
    totp.verifyTotpCode(secret, totp.totpCodeForStep(secret, step + 1), now),
    step + 1
  );
  const outside = totp.totpCodeForStep(secret, step + 2);
  const result = totp.verifyTotpCode(secret, outside, now);
  // A ±2 code only passes on the rare accidental collision with an in-window code.
  if (result !== null) {
    assert.ok([step - 1, step, step + 1].includes(result));
  }
  assert.equal(totp.verifyTotpCode(secret, 'abcdef', now), null);
  assert.equal(totp.verifyTotpCode(secret, '12345', now), null);
});

/* ------------------------------------- enrollment, login, challenges */

const password = 'Mfa-Test-Password-1!';
let admin;
let adminSecret;
let recoveryCodes;

test('bootstrap account enrolls and activates TOTP with recovery codes', async () => {
  const result = await authService.signup('mfa_admin', password, null, {
    kind: 'signup',
  });
  assert.equal(result?.status, 'authenticated');
  admin = result.user;

  const enrollment = await mfa.beginTotpEnrollment(admin.id, admin.username);
  adminSecret = enrollment.secret;
  assert.match(enrollment.otpauthUrl, /^otpauth:\/\/totp\//);
  assert.ok(enrollment.otpauthUrl.includes(enrollment.secret));

  let status = await mfa.getMfaStatus(admin.id);
  assert.equal(status.totpEnabled, false);
  assert.equal(status.totpPending, true);

  const code = totp.totpCodeForStep(adminSecret, totp.currentTotpStep());
  recoveryCodes = await mfa.activateTotp(admin.id, code);
  assert.equal(recoveryCodes.length, 10);
  for (const recoveryCode of recoveryCodes) {
    assert.match(recoveryCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  }

  status = await mfa.getMfaStatus(admin.id);
  assert.equal(status.totpEnabled, true);
  assert.equal(status.recoveryCodesRemaining, 10);
});

test('an accepted TOTP step cannot be replayed', async () => {
  // The activation above consumed the current step; the same code must fail.
  const usedCode = totp.totpCodeForStep(adminSecret, totp.currentTotpStep());
  const replay = await mfa.verifySecondFactor(admin.id, usedCode);
  assert.equal(replay.verified, false);
  // The next step (inside the skew window) still verifies.
  const nextCode = totp.totpCodeForStep(
    adminSecret,
    totp.currentTotpStep() + 1
  );
  const accepted = await mfa.verifySecondFactor(admin.id, nextCode);
  assert.equal(accepted.verified, true);
  assert.equal(accepted.method, 'totp');
});

test('password login returns an MFA challenge, and the challenge is not a session', async () => {
  const result = await authService.login('mfa_admin', password, {
    kind: 'password',
  });
  assert.equal(result?.status, 'mfa');
  assert.equal(result.requirement, 'verify');
  assert.ok(result.challengeToken);

  // The challenge token must never authenticate an API request.
  const outcome = await callAuthenticate(result.challengeToken);
  assert.equal(outcome.status, 401);

  const challenge = mfa.peekMfaChallenge(result.challengeToken, 'mfa-verify');
  assert.equal(challenge.userId, admin.id);
  assert.throws(() =>
    mfa.peekMfaChallenge(result.challengeToken, 'mfa-enroll')
  );

  // One-use: the first consume wins, the second is refused.
  assert.equal(await mfa.consumeMfaChallenge(challenge.jti), true);
  assert.equal(await mfa.consumeMfaChallenge(challenge.jti), false);
});

test('recovery codes sign in exactly once', async () => {
  const [first] = recoveryCodes;
  const consumed = await mfa.consumeRecoveryCode(admin.id, first);
  assert.equal(consumed.consumed, true);
  assert.equal(consumed.remaining, 9);
  const again = await mfa.consumeRecoveryCode(admin.id, first);
  assert.equal(again.consumed, false);
  // Normalized entry (lowercase, no dash) still matches.
  const [, second] = recoveryCodes;
  const relaxed = await mfa.verifySecondFactor(
    admin.id,
    second.toLowerCase().replace('-', ' ')
  );
  assert.equal(relaxed.verified, true);
  assert.equal(relaxed.method, 'recovery');
});

test('the required policy forces enrollment for accounts without MFA', async () => {
  assert.equal(await mfa.getMfaRequiredMode(), 'optional');
  await mfa.setMfaRequiredMode('required');

  const signup = await authService.signup('mfa_member', password, null, {
    kind: 'signup',
  });
  // Second registration is held for approval in this instance profile.
  const memberId = signup.user.id;
  const requirement = await mfa.loginRequirement(memberId);
  assert.equal(requirement, 'enroll');

  await mfa.setMfaRequiredMode('optional');
  assert.equal(await mfa.loginRequirement(memberId), 'none');
});

test('disable requires a valid factor and admin reset clears everything', async () => {
  await assert.rejects(() => mfa.disableTotp(admin.id, '000000'), {
    statusCode: 401,
  });
  // The replay guard already consumed the current and next TOTP steps, so a
  // recovery code is the honest disable path here.
  await mfa.disableTotp(admin.id, recoveryCodes[2]);
  let status = await mfa.getMfaStatus(admin.id);
  assert.equal(status.totpEnabled, false);
  assert.equal(status.recoveryCodesRemaining, 0);

  // Re-enroll, then verify the admin reset path.
  const enrollment = await mfa.beginTotpEnrollment(admin.id, admin.username);
  await mfa.activateTotp(
    admin.id,
    totp.totpCodeForStep(enrollment.secret, totp.currentTotpStep())
  );
  assert.equal((await mfa.getMfaStatus(admin.id)).totpEnabled, true);
  assert.equal(await mfa.adminResetMfa(admin.id), true);
  assert.equal((await mfa.getMfaStatus(admin.id)).totpEnabled, false);
  assert.equal(await mfa.loginRequirement(admin.id), 'none');
});

/* --------------------------------------------------------- WebAuthn */

// Minimal CBOR encoder for the test fixtures (uint, neg, bytes, text, map).
const cborUint = (major, value) => {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  const header = Buffer.alloc(3);
  header[0] = (major << 5) | 25;
  header.writeUInt16BE(value, 1);
  return header;
};
const cborEncode = value => {
  if (typeof value === 'number') {
    return value >= 0 ? cborUint(0, value) : cborUint(1, -1 - value);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([cborUint(2, value.length), value]);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborUint(3, bytes.length), bytes]);
  }
  if (value instanceof Map) {
    const parts = [cborUint(5, value.size)];
    for (const [key, entry] of value) {
      parts.push(cborEncode(key), cborEncode(entry));
    }
    return Buffer.concat(parts);
  }
  throw new Error('unsupported test CBOR value');
};

const RP_HOST = 'localhost:3001';
const ORIGIN = 'http://localhost:5173';

const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = keyPair.publicKey.export({ format: 'jwk' });
const coseKey = new Map([
  [1, 2],
  [3, -7],
  [-1, 1],
  [-2, Buffer.from(jwk.x, 'base64url')],
  [-3, Buffer.from(jwk.y, 'base64url')],
]);
const credentialId = randomBytes(32);

const buildAuthData = (flags, signCount, includeCredential) => {
  const rpIdHash = createHash('sha256').update('localhost').digest();
  const head = Buffer.alloc(37);
  rpIdHash.copy(head, 0);
  head[32] = flags;
  head.writeUInt32BE(signCount, 33);
  if (!includeCredential) return head;
  const credentialLength = Buffer.alloc(2);
  credentialLength.writeUInt16BE(credentialId.length);
  return Buffer.concat([
    head,
    Buffer.alloc(16), // AAGUID
    credentialLength,
    credentialId,
    cborEncode(coseKey),
  ]);
};

const clientData = (type, challenge, origin = ORIGIN) =>
  Buffer.from(JSON.stringify({ type, challenge, origin }), 'utf8');

let passkeyRecord;

test('a passkey registers with none attestation and ES256', async () => {
  const options = await webauthnService.registrationOptions(
    { id: admin.id, username: admin.username },
    RP_HOST
  );
  assert.equal(options.publicKey.rp.id, 'localhost');
  const attestationObject = cborEncode(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', buildAuthData(0x45, 0, true)],
    ])
  );
  passkeyRecord = await webauthnService.registerPasskey(
    admin.id,
    {
      challengeToken: options.challengeToken,
      name: 'Test key',
      credential: {
        rawId: credentialId.toString('base64url'),
        response: {
          clientDataJSON: clientData(
            'webauthn.create',
            options.publicKey.challenge
          ).toString('base64url'),
          attestationObject: attestationObject.toString('base64url'),
          transports: ['internal'],
        },
      },
    },
    RP_HOST
  );
  assert.equal(passkeyRecord.name, 'Test key');
  const listed = await webauthnService.listPasskeys(admin.id);
  assert.equal(listed.length, 1);
});

const buildAssertion = (challenge, { origin = ORIGIN, signCount = 1 } = {}) => {
  const authData = buildAuthData(0x05, signCount, false);
  const clientDataJson = clientData('webauthn.get', challenge, origin);
  const signature = cryptoSign(
    'sha256',
    Buffer.concat([authData, createHash('sha256').update(clientDataJson).digest()]),
    { key: keyPair.privateKey, dsaEncoding: 'der' }
  );
  return {
    rawId: credentialId.toString('base64url'),
    response: {
      clientDataJSON: clientDataJson.toString('base64url'),
      authenticatorData: authData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
  };
};

test('a passkey assertion signs the user in and challenges are one-use', async () => {
  const options = await webauthnService.loginOptions(RP_HOST);
  const verified = await webauthnService.verifyPasskeyLogin(
    {
      challengeToken: options.challengeToken,
      credential: buildAssertion(options.publicKey.challenge),
    },
    RP_HOST
  );
  assert.equal(verified.userId, admin.id);
  assert.equal(verified.passkeyId, passkeyRecord.id);

  // The consumed challenge is refused on a second attempt.
  await assert.rejects(
    () =>
      webauthnService.verifyPasskeyLogin(
        {
          challengeToken: options.challengeToken,
          credential: buildAssertion(options.publicKey.challenge, {
            signCount: 2,
          }),
        },
        RP_HOST
      ),
    /already used/
  );
});

test('a foreign origin, a bad signature, and a stale counter are rejected', async () => {
  const foreign = await webauthnService.loginOptions(RP_HOST);
  await assert.rejects(
    () =>
      webauthnService.verifyPasskeyLogin(
        {
          challengeToken: foreign.challengeToken,
          credential: buildAssertion(foreign.publicKey.challenge, {
            origin: 'https://evil.example',
            signCount: 3,
          }),
        },
        RP_HOST
      ),
    /another site/
  );

  const tampered = await webauthnService.loginOptions(RP_HOST);
  const assertion = buildAssertion(tampered.publicKey.challenge, {
    signCount: 3,
  });
  assertion.response.signature = randomBytes(70).toString('base64url');
  await assert.rejects(
    () =>
      webauthnService.verifyPasskeyLogin(
        { challengeToken: tampered.challengeToken, credential: assertion },
        RP_HOST
      ),
    /signature verification failed/
  );

  // The clone check: a nonzero counter that does not advance is refused.
  const stale = await webauthnService.loginOptions(RP_HOST);
  await assert.rejects(
    () =>
      webauthnService.verifyPasskeyLogin(
        {
          challengeToken: stale.challengeToken,
          credential: buildAssertion(stale.publicKey.challenge, {
            signCount: 1,
          }),
        },
        RP_HOST
      ),
    /clone check/
  );

  const removed = await webauthnService.deletePasskey(
    admin.id,
    passkeyRecord.id
  );
  assert.equal(removed, true);
});

test('malformed authenticator payloads fail closed', () => {
  assert.throws(() => webauthnUtils.decodeCbor(Buffer.from([0x5b])), {
    name: 'Error',
  });
  assert.throws(() =>
    webauthnUtils.parseAuthenticatorData(Buffer.alloc(10))
  );
  assert.equal(
    webauthnUtils.originMatchesRpId('https://app.example.com', 'example.com'),
    true
  );
  assert.equal(
    webauthnUtils.originMatchesRpId('https://example.com.evil.io', 'example.com'),
    false
  );
});
