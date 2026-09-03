import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-default-theme-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'default-theme-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
delete process.env.ENABLE_SIGNUP;

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [
  { getDefaultTheme, normalizeThemeInput, setDefaultTheme },
  { authService },
  { userModel },
  { default: preferencesService },
] = await Promise.all([
  importBuilt('services/appearanceSettingsService.js'),
  importBuilt('services/authService.js'),
  importBuilt('models/userModel.js'),
  importBuilt('services/preferencesService.js'),
]);

test('the administrator default theme reaches system info and new accounts', async () => {
  try {
    assert.equal((await getDefaultTheme()).mode, 'dark');
    assert.equal((await authService.getSystemInfo()).defaultTheme.mode, 'dark');

    // An existing account keeps its own saved theme across default changes.
    const owner = await authService.signup('owner', 'Owner-Password-123');
    assert.equal(owner?.status, 'authenticated');
    await preferencesService.updatePreferences(
      { theme: { mode: 'light' } },
      owner.user.id
    );

    await setDefaultTheme({ mode: 'amoled', accent: 'rose' });
    const systemInfo = await authService.getSystemInfo();
    assert.equal(systemInfo.defaultTheme.mode, 'amoled');
    assert.equal(systemInfo.defaultTheme.accent, 'rose');
    assert.equal(
      (await preferencesService.getPreferences(owner.user.id)).theme.mode,
      'light'
    );

    // A newcomer's preferences are seeded from the instance default.
    const member = await userModel.createUser({
      username: 'member',
      password: 'Member-Password-123',
      role: 'user',
    });
    const seeded = await preferencesService.getPreferences(member.id);
    assert.equal(seeded.theme.mode, 'amoled');
    assert.equal(seeded.theme.accent, 'rose');

    // Resetting an account's preferences returns to the instance default.
    const reset = await preferencesService.resetToDefaults(owner.user.id);
    assert.equal(reset.theme.mode, 'amoled');

    // Only known modes and accents are accepted.
    assert.equal(normalizeThemeInput({ mode: 'ophelia' }), null);
    assert.equal(normalizeThemeInput({ mode: 'dark', accent: 'neon' }), null);
    assert.equal(normalizeThemeInput({ customAccent: 'red' }), null);
    assert.equal(normalizeThemeInput('amoled'), null);
    assert.deepEqual(normalizeThemeInput({ mode: 'light' }), {
      mode: 'light',
      adaptToAccent: false,
      accent: 'blue',
      customAccent: '#4176e6',
    });
    await assert.rejects(setDefaultTheme({ mode: 'sepia' }), /Invalid theme/);
    assert.equal((await getDefaultTheme()).mode, 'amoled');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
