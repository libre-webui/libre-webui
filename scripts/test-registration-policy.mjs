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

test('public registration defaults to enabled', () => {
  const originalValue = process.env.ENABLE_SIGNUP;
  delete process.env.ENABLE_SIGNUP;

  try {
    assert.equal(isPublicRegistrationEnabled(), true);
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

test('local signup keeps first-administrator bootstrap available', () => {
  assert.equal(canCreateLocalAccount(0, false), true);
  assert.equal(canCreateLocalAccount(1, false), false);
  assert.equal(canCreateLocalAccount(2, true), true);
});
