import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const modulePath = pathToFileURL(
  path.resolve('backend/dist/services/registrationPolicy.js')
).href;

const { canCreateLocalAccount, isPublicRegistrationEnabled } = await import(
  modulePath
);
const { parseJwtLifetime } = await import(
  pathToFileURL(path.resolve('backend/dist/services/authService.js')).href
);

test('public registration defaults to disabled', () => {
  const originalValue = process.env.ENABLE_SIGNUP;
  delete process.env.ENABLE_SIGNUP;

  try {
    assert.equal(isPublicRegistrationEnabled(), false);
    assert.equal(isPublicRegistrationEnabled('true'), true);
  } finally {
    if (originalValue === undefined) delete process.env.ENABLE_SIGNUP;
    else process.env.ENABLE_SIGNUP = originalValue;
  }
});

test('ENABLE_SIGNUP=false disables public registration', () => {
  assert.equal(isPublicRegistrationEnabled('false'), false);
  assert.equal(isPublicRegistrationEnabled(' FALSE '), false);
});

test('only an explicit true value enables public registration', () => {
  assert.equal(isPublicRegistrationEnabled('1'), false);
  assert.equal(isPublicRegistrationEnabled('yes'), false);
  assert.equal(isPublicRegistrationEnabled(' TRUE '), true);
});

test('bootstrap remains available while later registration is closed', () => {
  assert.equal(canCreateLocalAccount(0, false), true);
  assert.equal(canCreateLocalAccount(1, false), false);
  assert.equal(canCreateLocalAccount(0, true), true);
  assert.equal(canCreateLocalAccount(2, true), true);
});

test('session-token lifetime accepts documented durations and fails closed', () => {
  assert.equal(parseJwtLifetime(undefined), '7d');
  assert.equal(parseJwtLifetime(' 15m '), '15m');
  assert.equal(parseJwtLifetime('3600'), 3600);
  assert.equal(parseJwtLifetime('forever'), '7d');
});
