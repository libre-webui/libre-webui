import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { validatePasswordStrength } = await import(
  pathToFileURL(path.resolve('backend/dist/utils/hash.js')).href
);

test('password policy rejects weak and bcrypt-truncated passwords', () => {
  assert.equal(validatePasswordStrength(null).isValid, false);
  assert.equal(validatePasswordStrength('short').isValid, false);
  assert.equal(
    validatePasswordStrength('long-but-no-uppercase-or-number').isValid,
    false
  );
  assert.equal(validatePasswordStrength(`Aa1${'x'.repeat(70)}`).isValid, false);
  assert.equal(validatePasswordStrength('Strong-Password-123').isValid, true);
});

test('password policy is enforced by public and administrator APIs', () => {
  for (const file of [
    'backend/src/routes/auth.ts',
    'backend/src/routes/users.ts',
    'backend/src/services/authService.ts',
  ]) {
    assert.match(
      fs.readFileSync(path.resolve(file), 'utf8'),
      /validatePasswordStrength/,
      file
    );
  }
});
