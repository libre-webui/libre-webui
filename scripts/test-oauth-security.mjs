import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

const {
  beginOAuthFlow,
  consumeOAuthSessionCookie,
  consumeOAuthState,
  setOAuthSessionCookie,
} = await importBuilt('services/oauthSecurity.js');
const { GitHubOAuthService } = await importBuilt(
  'services/simpleGitHubOAuth.js'
);
const { HuggingFaceOAuthService } = await importBuilt(
  'services/simpleHuggingFaceOAuth.js'
);

const request = (cookie = '', secure = false) => ({
  headers: { cookie },
  protocol: secure ? 'https' : 'http',
  secure,
});

const response = () => {
  const writes = [];
  const clears = [];
  return {
    writes,
    clears,
    cookie(name, value, options) {
      writes.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      clears.push({ name, options });
      return this;
    },
  };
};

test('OAuth providers receive a browser-bound state value', () => {
  const originalGitHubClientId = process.env.GITHUB_CLIENT_ID;
  const originalHuggingFaceClientId = process.env.HUGGINGFACE_CLIENT_ID;
  process.env.GITHUB_CLIENT_ID = 'github-client';
  process.env.HUGGINGFACE_CLIENT_ID = 'huggingface-client';

  try {
    const state = 'browser-bound-state';
    const github = new URL(new GitHubOAuthService().getAuthUrl(state));
    const huggingface = new URL(
      new HuggingFaceOAuthService().getAuthUrl(state)
    );
    assert.equal(github.searchParams.get('state'), state);
    assert.equal(huggingface.searchParams.get('state'), state);
  } finally {
    if (originalGitHubClientId === undefined)
      delete process.env.GITHUB_CLIENT_ID;
    else process.env.GITHUB_CLIENT_ID = originalGitHubClientId;
    if (originalHuggingFaceClientId === undefined) {
      delete process.env.HUGGINGFACE_CLIENT_ID;
    } else {
      process.env.HUGGINGFACE_CLIENT_ID = originalHuggingFaceClientId;
    }
  }
});

test('OAuth state is random, HttpOnly, short-lived, and consumed once', () => {
  const startResponse = response();
  const state = beginOAuthFlow(request(), startResponse, 'github');
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(startResponse.writes[0], {
    name: 'libre_oauth_state_github',
    value: state,
    options: {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/api/auth/oauth/github',
      maxAge: 600000,
    },
  });

  const callbackResponse = response();
  assert.equal(
    consumeOAuthState(
      request(`libre_oauth_state_github=${state}`),
      callbackResponse,
      'github',
      state
    ),
    true
  );
  assert.equal(callbackResponse.clears.length, 1);
  assert.equal(
    consumeOAuthState(request(), response(), 'github', state),
    false
  );
  assert.equal(
    consumeOAuthState(
      request('libre_oauth_state_github=different'),
      response(),
      'github',
      state
    ),
    false
  );
});

test('OAuth bearer token crosses the redirect boundary only in HttpOnly cookie', () => {
  const setResponse = response();
  setOAuthSessionCookie(request(), setResponse, 'signed.jwt.token');
  assert.deepEqual(setResponse.writes[0], {
    name: 'libre_oauth_session',
    value: 'signed.jwt.token',
    options: {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api/auth/oauth',
      maxAge: 60000,
    },
  });

  const exchangeResponse = response();
  assert.equal(
    consumeOAuthSessionCookie(
      request('other=value; libre_oauth_session=signed.jwt.token'),
      exchangeResponse
    ),
    'signed.jwt.token'
  );
  assert.equal(exchangeResponse.clears.length, 1);

  const authRoutes = fs.readFileSync(
    path.resolve('backend/src/routes/auth.ts'),
    'utf8'
  );
  const app = fs.readFileSync(path.resolve('frontend/src/App.tsx'), 'utf8');
  assert.doesNotMatch(authRoutes, /\?token=\$\{token\}/);
  assert.doesNotMatch(app, /urlParams\.get\('token'\)/);
  assert.match(authRoutes, /consumeOAuthState/);
  assert.match(authRoutes, /'\/oauth\/exchange'/);
  assert.match(app, /\/auth\/oauth\/exchange/);
});
