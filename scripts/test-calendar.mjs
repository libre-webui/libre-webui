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
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const distRoot = path.join(repoRoot, 'backend', 'dist');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-calendar-'));
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.ENCRYPTION_KEY = '1'.repeat(64);
process.env.JWT_SECRET = 'calendar-test-secret';

const importDist = relativePath =>
  import(pathToFileURL(path.join(distRoot, relativePath)).href);

const databaseModule = await importDist('db.js');
const database = databaseModule.getDatabase();
const { authService } = await importDist('services/authService.js');
const calendarRouter = (await importDist('routes/calendar.js')).default;

const now = Date.now();
const createUser = id => {
  database
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, account_status, avatar,
          created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', 'user', 'active', NULL, ?, ?)`
    )
    .run(id, id, now, now);
  return authService.generateToken({
    id,
    username: id,
    email: null,
    role: 'user',
    status: 'active',
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
};

const ownerToken = createUser('calendar-owner');
const strangerToken = createUser('calendar-stranger');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/calendar', calendarRouter);
const server = http.createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/api/calendar`;
const headersFor = token => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  databaseModule.closeDatabase();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

const dayMs = 24 * 60 * 60 * 1000;

test('calendar events persist per owner and expand recurrence into range queries', async () => {
  // Create a one-off event.
  const startAt = new Date(2030, 5, 10, 14, 0).getTime();
  let response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      title: 'Dentist',
      notes: 'bring insurance card',
      startAt,
      endAt: startAt + 60 * 60 * 1000,
    }),
  });
  assert.equal(response.status, 200);
  const created = (await response.json()).data;
  assert.equal(created.title, 'Dentist');

  // Create a weekly recurring event.
  const weeklyStart = new Date(2030, 5, 3, 9, 30).getTime();
  response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      title: 'Standup',
      startAt: weeklyStart,
      recurrence: {
        kind: 'weekly',
        dayOfWeek: new Date(weeklyStart).getDay(),
        hour: 9,
        minute: 30,
      },
    }),
  });
  assert.equal(response.status, 200);
  const recurring = (await response.json()).data;

  // A three-week range returns the one-off plus expanded occurrences that
  // carry baseEventId back to the recurring source event.
  const from = new Date(2030, 5, 1).getTime();
  const to = new Date(2030, 5, 22).getTime();
  response = await fetch(`${baseUrl}/events?from=${from}&to=${to}`, {
    headers: headersFor(ownerToken),
  });
  assert.equal(response.status, 200);
  const events = (await response.json()).data;
  const standups = events.filter(event => event.title === 'Standup');
  assert.equal(standups.length, 3, 'weekly event occurs three times in range');
  const occurrences = standups.filter(event => event.baseEventId);
  assert.equal(occurrences.length, 2);
  assert.ok(occurrences.every(event => event.baseEventId === recurring.id));
  assert.ok(events.some(event => event.id === created.id));
  // Range results come back sorted.
  const startTimes = events.map(event => event.startAt);
  assert.deepEqual(
    startTimes,
    [...startTimes].sort((a, b) => a - b)
  );

  // Update reprices the range query.
  response = await fetch(`${baseUrl}/events/${created.id}`, {
    method: 'PUT',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      title: 'Dentist (moved)',
      startAt: startAt + dayMs,
      endAt: startAt + dayMs + 60 * 60 * 1000,
    }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.title, 'Dentist (moved)');

  // Another user sees an empty calendar and cannot touch the owner's events.
  response = await fetch(`${baseUrl}/events?from=${from}&to=${to}`, {
    headers: headersFor(strangerToken),
  });
  assert.deepEqual((await response.json()).data, []);
  response = await fetch(`${baseUrl}/events/${created.id}`, {
    method: 'DELETE',
    headers: headersFor(strangerToken),
  });
  assert.equal(response.status, 404);

  // Invalid payloads are rejected before persistence.
  response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({ title: 'x'.repeat(500), startAt }),
  });
  assert.equal(response.status, 400);
  response = await fetch(`${baseUrl}/events`, {
    method: 'POST',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      title: 'bad recurrence',
      startAt,
      recurrence: { kind: 'weekly', dayOfWeek: 9, hour: 9, minute: 0 },
    }),
  });
  assert.equal(response.status, 400);
  response = await fetch(`${baseUrl}/events?from=${to}&to=${from}`, {
    headers: headersFor(ownerToken),
  });
  assert.equal(response.status, 400);

  // Delete removes the event for its owner.
  response = await fetch(`${baseUrl}/events/${created.id}`, {
    method: 'DELETE',
    headers: headersFor(ownerToken),
  });
  assert.equal(response.status, 200);
  response = await fetch(`${baseUrl}/events?from=${from}&to=${to}`, {
    headers: headersFor(ownerToken),
  });
  assert.ok(
    (await response.json()).data.every(event => event.id !== created.id)
  );
});

test('calendar requests without credentials are rejected', async () => {
  const from = new Date(2030, 5, 1).getTime();
  const to = new Date(2030, 5, 22).getTime();
  const response = await fetch(`${baseUrl}/events?from=${from}&to=${to}`);
  assert.equal(response.status, 401);
});
