import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-default-model-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'default-model-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
delete process.env.ENABLE_SIGNUP;
process.env.DEFAULT_MODEL = ' llama3.2 ';

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const [{ default: preferencesService, instanceDefaultModel }, { authService }] =
  await Promise.all([
    importBuilt('services/preferencesService.js'),
    importBuilt('services/authService.js'),
  ]);

test('DEFAULT_MODEL seeds accounts until they choose a model of their own', async () => {
  try {
    assert.equal(instanceDefaultModel(), 'llama3.2');

    // A fresh account starts on the operator's model.
    const owner = await authService.signup('owner', 'Owner-Password-123');
    assert.equal(owner?.status, 'authenticated');
    const seeded = await preferencesService.getPreferences(owner.user.id);
    assert.equal(seeded.defaultModel, 'llama3.2');

    // The user's own pick wins and survives a change of the operator model.
    await preferencesService.updatePreferences(
      { defaultModel: 'qwen3:8b' },
      owner.user.id
    );
    process.env.DEFAULT_MODEL = 'gemma3';
    assert.equal(
      (await preferencesService.getPreferences(owner.user.id)).defaultModel,
      'qwen3:8b'
    );

    // Clearing the pick falls back to whatever the operator runs now.
    await preferencesService.updatePreferences(
      { defaultModel: '' },
      owner.user.id
    );
    assert.equal(
      (await preferencesService.getPreferences(owner.user.id)).defaultModel,
      'gemma3'
    );

    // Without the variable the slot is empty, exactly as before.
    delete process.env.DEFAULT_MODEL;
    assert.equal(instanceDefaultModel(), '');
    assert.equal(
      (await preferencesService.getPreferences(owner.user.id)).defaultModel,
      ''
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
