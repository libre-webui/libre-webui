import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const authRoute = fs.readFileSync(
  path.resolve('backend/src/routes/auth.ts'),
  'utf8'
);
const loginStart = authRoute.indexOf("router.post('/login'");
const loginEnd = authRoute.indexOf('/**\n * Logout endpoint', loginStart);
const loginRoute = authRoute.slice(loginStart, loginEnd);

const modulePath = pathToFileURL(
  path.resolve('backend/dist/services/turnstileService.js')
).href;
const { TurnstileService } = await import(modulePath);

test('password login verifies Turnstile before checking credentials', () => {
  assert.notEqual(loginStart, -1);
  assert.notEqual(loginEnd, -1);
  assert.match(loginRoute, /turnstileToken/);
  assert.match(loginRoute, /turnstileService\.verify/);
  assert.match(loginRoute, /getClientIp\(req\)/);
  assert.ok(
    loginRoute.indexOf('turnstileService.verify') <
      loginRoute.indexOf('authService.login')
  );
});

test('Turnstile verification sends the login token and client IP', async () => {
  const originalSiteKey = process.env.TURNSTILE_SITE_KEY;
  const originalSecretKey = process.env.TURNSTILE_SECRET_KEY;
  const originalFetch = globalThis.fetch;
  let submittedBody;

  process.env.TURNSTILE_SITE_KEY = 'test-site-key';
  process.env.TURNSTILE_SECRET_KEY = 'test-secret-key';
  globalThis.fetch = async (_url, init) => {
    submittedBody = init?.body;
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const turnstile = new TurnstileService();
    assert.equal(await turnstile.verify('login-token', '203.0.113.10'), true);
    assert.ok(submittedBody instanceof URLSearchParams);
    assert.equal(submittedBody.get('secret'), 'test-secret-key');
    assert.equal(submittedBody.get('response'), 'login-token');
    assert.equal(submittedBody.get('remoteip'), '203.0.113.10');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSiteKey === undefined) delete process.env.TURNSTILE_SITE_KEY;
    else process.env.TURNSTILE_SITE_KEY = originalSiteKey;
    if (originalSecretKey === undefined)
      delete process.env.TURNSTILE_SECRET_KEY;
    else process.env.TURNSTILE_SECRET_KEY = originalSecretKey;
  }
});
