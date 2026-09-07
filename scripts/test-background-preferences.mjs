/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import { initializeSQLitePlatformStorageFixture } from './lib/platform-storage-fixture.mjs';

const dataDir = mkdtempSync(
  path.join(tmpdir(), 'libre-background-preferences-')
);
process.env.DATA_DIR = dataDir;
process.env.DATABASE_BACKEND = 'sqlite';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'background-preferences-regression-secret';

const distRoot = path.resolve('backend/dist');
const importBuilt = file =>
  import(pathToFileURL(path.join(distRoot, file)).href);
const closeFixture = await initializeSQLitePlatformStorageFixture(distRoot);
const [
  { default: preferences },
  { default: storage },
  { userModel },
  { authService },
  { default: preferencesRouter },
  { deferPreferencesUpdateJson },
  { errorHandler },
] = await Promise.all([
  importBuilt('services/preferencesService.js'),
  importBuilt('storage.js'),
  importBuilt('models/userModel.js'),
  importBuilt('services/authService.js'),
  importBuilt('routes/preferences.js'),
  importBuilt('middleware/preferencesBody.js'),
  importBuilt('middleware/index.js'),
]);

const app = express();
app.use(deferPreferencesUpdateJson(express.json({ limit: '10mb' })));
app.use('/api/preferences', preferencesRouter);
app.put('/api/unrelated', (_req, res) => res.json({ success: true }));
app.use(errorHandler);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address !== 'string');
const baseUrl = `http://127.0.0.1:${address.port}`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await closeFixture();
  const { closeDatabase } = await importBuilt('db.js');
  closeDatabase();
  rmSync(dataDir, { recursive: true, force: true });
});

test('the authenticated preferences write accepts a base64-encoded 10 MiB wallpaper', async () => {
  const user = await userModel.createUser({
    username: 'large-wallpaper-owner',
    password: 'Wallpaper-Test-Password-123',
    role: 'user',
  });
  const token = authService.generateToken(user);
  const imageUrl = `data:image/png;base64,${Buffer.alloc(10 * 1024 * 1024, 0xa5).toString('base64')}`;
  const body = JSON.stringify({
    backgroundSettings: {
      enabled: true,
      imageUrl,
      opacity: 0.5,
      blurAmount: 0,
      effect: 'dither',
    },
  });
  assert.ok(Buffer.byteLength(body) > 10 * 1024 * 1024);
  assert.ok(Buffer.byteLength(body) < 16 * 1024 * 1024);

  for (const suffix of ['', '/?source=wallpaper']) {
    const response = await fetch(`${baseUrl}/api/preferences${suffix}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body,
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true);
    assert.equal(result.data.backgroundSettings.imageUrl, imageUrl);
  }
  assert.equal(
    (await preferences.getPreferences(user.id)).backgroundSettings.imageUrl,
    imageUrl
  );

  const anonymous = await fetch(`${baseUrl}/api/preferences`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(16 * 1024 * 1024) }),
  });
  assert.equal(anonymous.status, 401);
  await anonymous.json();

  const excessive = await fetch(`${baseUrl}/api/preferences`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ padding: 'x'.repeat(16 * 1024 * 1024) }),
  });
  assert.equal(excessive.status, 413);
  assert.equal((await excessive.json()).error, 'Request body is too large');
  assert.equal(
    (await preferences.getPreferences(user.id)).backgroundSettings.imageUrl,
    imageUrl
  );
});

test('other paths and methods retain the global 10 MiB JSON limit', async () => {
  const body = JSON.stringify({ padding: 'x'.repeat(10 * 1024 * 1024) });
  for (const [method, route] of [
    ['PUT', '/api/unrelated'],
    ['PUT', '/api/preferences/system-message'],
    ['POST', '/api/preferences'],
  ]) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(response.status, 413, `${method} ${route}`);
    assert.equal((await response.json()).error, 'Request body is too large');
  }
});

test('wallpaper preferences normalize legacy records and retain original images across partial patches', async () => {
  const user = await userModel.createUser({
    username: 'wallpaper-test',
    password: 'Wallpaper-Test-Password-123',
    role: 'admin',
  });
  const initial = await preferences.getPreferences(user.id);
  assert.deepEqual(initial.backgroundSettings, {
    enabled: false,
    imageUrl: '',
    blurAmount: 10,
    opacity: 0.6,
    effect: 'dither',
  });
  const imageUrl = 'data:image/png;base64,original-wallpaper-source==';
  await storage.mutatePreferences(
    current => ({
      ...current,
      backgroundSettings: {
        enabled: true,
        imageUrl,
        blurAmount: 0,
        opacity: 0,
      },
    }),
    user.id
  );
  assert.deepEqual(
    (await preferences.getPreferences(user.id)).backgroundSettings,
    {
      enabled: true,
      imageUrl,
      blurAmount: 0,
      opacity: 0,
      effect: 'dither',
    }
  );

  await preferences.updatePreferences(
    { backgroundSettings: { effect: 'blur' } },
    user.id
  );
  let saved = (await preferences.getPreferences(user.id)).backgroundSettings;
  assert.equal(saved.effect, 'blur');
  assert.equal(saved.imageUrl, imageUrl);
  assert.equal(saved.blurAmount, 0);
  assert.equal(saved.opacity, 0);

  await preferences.updatePreferences(
    {
      backgroundSettings: { effect: 'unknown', blurAmount: -4, opacity: 5 },
    },
    user.id
  );
  saved = (await preferences.getPreferences(user.id)).backgroundSettings;
  assert.equal(saved.effect, 'dither');
  assert.equal(saved.blurAmount, 0);
  assert.equal(saved.opacity, 1);
  assert.equal(saved.imageUrl, imageUrl);
  const persisted = (await storage.getPreferences(user.id)).backgroundSettings;
  assert.deepEqual(persisted, saved);
});
