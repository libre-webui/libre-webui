/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(import.meta.dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-hf-hub-routes-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'hugging-face-hub-route-test-secret';
process.env.ENCRYPTION_KEY ||= '6a'.repeat(32);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const coordinationModule = await distModule('platform/coordination/service.js');
await coordinationModule.initializeCoordinator();
const persistenceModule = await distModule('persistence/index.js');
const persistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const [{ authService }, { default: huggingFaceHubRouter }] = await Promise.all([
  distModule('services/authService.js'),
  distModule('routes/huggingfaceHub.js'),
]);

const now = Date.now();
const userRecords = [
  {
    id: 'hf-hub-user',
    username: 'hf-hub-user',
    role: 'user',
  },
  {
    id: 'hf-hub-admin',
    username: 'hf-hub-admin',
    role: 'admin',
  },
];
for (const user of userRecords) {
  await persistence.repositories.identity.insert({
    ...user,
    email: null,
    password_hash: 'unused',
    account_status: 'active',
    approved_at: now,
    approved_by: null,
    avatar: null,
    created_at: now,
    updated_at: now,
  });
}

const tokenFor = user =>
  authService.generateToken({
    id: user.id,
    username: user.username,
    email: null,
    role: user.role,
    status: 'active',
    approvedAt: new Date(now).toISOString(),
    approvedBy: null,
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
const userToken = tokenFor(userRecords[0]);
const adminToken = tokenFor(userRecords[1]);

const app = express();
app.use(express.json());
app.use('/api/huggingface-hub', huggingFaceHubRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Hugging Face Hub route test server has no TCP address');
}
const baseUrl = `http://127.0.0.1:${address.port}/api/huggingface-hub`;

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await coordinationModule.closeCoordinator();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

test('Hugging Face Hub task discovery is authenticated route behavior', async () => {
  const unauthenticated = await fetch(`${baseUrl}/tasks`);
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(await unauthenticated.json(), {
    success: false,
    message: 'No authorization token provided',
  });

  const authenticated = await fetch(`${baseUrl}/tasks`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), {
    success: true,
    data: [
      'text-generation',
      'text2text-generation',
      'text-to-speech',
      'automatic-speech-recognition',
      'text-to-image',
      'image-to-text',
      'feature-extraction',
      'fill-mask',
      'question-answering',
      'summarization',
      'translation',
      'zero-shot-classification',
    ],
  });
});

test('Hugging Face Hub cache mutation requires a current administrator', async () => {
  const forbidden = await fetch(`${baseUrl}/cache/clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userToken}` },
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), {
    success: false,
    message: 'Admin access required',
  });

  const cleared = await fetch(`${baseUrl}/cache/clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { success: true, data: true });
});
