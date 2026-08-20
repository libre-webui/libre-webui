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

/*
 * Team calendar (CAL-01 completion): named calendars with colors,
 * grant-based sharing with per-request authorization and owner-scoped
 * event storage, ICS import/export round-trips, single-fire reminders
 * into the notification inbox, and model-facing calendar tools.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-cal-team-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'calendar-team-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '7'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const applicationPersistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const platformStorageModule = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await platformStorageModule.initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: encryptionService,
  env: process.env,
});
const { initializeCoordinator, getCoordinator } = await distModule(
  'platform/coordination/service.js'
);
await initializeCoordinator();
const jobsModule = await distModule('platform/jobs/index.js');
const runtime = jobsModule.initializeDurableJobRuntime({
  role: 'embedded',
  runWorker: false,
  handlers: new Map(),
  env: process.env,
});
const eventsModule = await distModule('platform/events/index.js');
eventsModule.initializeDurableEventGateway(runtime.service, getCoordinator());

const [
  { getDatabase },
  { calendarService },
  grantService,
  { notificationService },
  { BUILTIN_TOOL_NAMES, executeBuiltinTool },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/calendarService.js'),
  distModule('services/resourceGrantService.js'),
  distModule('services/notificationService.js'),
  distModule('services/builtinToolsService.js'),
]);

const database = getDatabase();
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
};
const OWNER = 'cal-owner';
const FRIEND = 'cal-friend';
const STRANGER = 'cal-stranger';
for (const id of [OWNER, FRIEND, STRANGER]) createUser(id);
const owner = { userId: OWNER, role: 'user' };
const friend = { userId: FRIEND, role: 'user' };
const stranger = { userId: STRANGER, role: 'user' };

after(async () => {
  await runtime.close?.();
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

const hourMs = 60 * 60 * 1000;

test('named calendars carry colors and share read/write through grants', async () => {
  const calendar = await calendarService.saveCalendar(owner, {
    name: 'Team roadmap',
    color: '#7c3aed',
  });
  assert.equal(calendar.color, '#7c3aed');

  const start = new Date(2031, 2, 10, 9, 30).getTime();
  await calendarService.saveEventForActor(
    owner,
    {
      id: randomUUID(),
      title: 'Roadmap review',
      startAt: start,
      endAt: start + hourMs,
      allDay: false,
      createdAt: now,
      updatedAt: now,
    },
    calendar.id
  );

  // Nothing is visible without a grant.
  assert.equal((await calendarService.listCalendars(friend)).length, 0);
  const before = await calendarService.listEventsForActor(friend, {
    from: start - hourMs,
    to: start + hourMs,
  });
  assert.equal(before.events.length, 0);

  const readGrant = await grantService.createGrant(owner, {
    resourceType: 'calendar',
    resourceId: calendar.id,
    principalType: 'user',
    principalId: FRIEND,
    permission: 'read',
  });

  const calendars = await calendarService.listCalendars(friend);
  assert.equal(calendars.length, 1);
  assert.equal(calendars[0].name, 'Team roadmap');
  assert.equal(calendars[0].shared.permission, 'read');

  const visible = await calendarService.listEventsForActor(friend, {
    from: start - hourMs,
    to: start + hourMs,
  });
  assert.equal(visible.events.length, 1);
  assert.equal(visible.events[0].title, 'Roadmap review');
  assert.equal(visible.events[0].shared.permission, 'read');
  // Strangers still see nothing.
  assert.equal(
    (
      await calendarService.listEventsForActor(stranger, {
        from: start - hourMs,
        to: start + hourMs,
      })
    ).events.length,
    0
  );

  // A read grant cannot write into the calendar.
  await assert.rejects(
    calendarService.saveEventForActor(
      friend,
      {
        id: randomUUID(),
        title: 'Sneaky insert',
        startAt: start + 2 * hourMs,
        allDay: false,
        createdAt: now,
        updatedAt: now,
      },
      calendar.id
    ),
    { statusCode: 404 }
  );

  // Upgrade to write: the collaborator creates an event that the OWNER owns.
  await grantService.deleteGrant(owner, readGrant.id);
  await grantService.createGrant(owner, {
    resourceType: 'calendar',
    resourceId: calendar.id,
    principalType: 'user',
    principalId: FRIEND,
    permission: 'write',
  });
  const collaborative = await calendarService.saveEventForActor(
    friend,
    {
      id: randomUUID(),
      title: 'Added by collaborator',
      startAt: start + 3 * hourMs,
      allDay: false,
      createdAt: now,
      updatedAt: now,
    },
    calendar.id
  );
  assert.equal(collaborative.ownerUserId, OWNER);
  const ownerRow = database
    .prepare('SELECT user_id FROM calendar_events WHERE id = ?')
    .get(collaborative.event.id);
  assert.equal(ownerRow.user_id, OWNER);

  // The collaborator can edit it; the owner sees it without shared meta.
  const editable = await calendarService.requireWritableEvent(
    friend,
    collaborative.event.id
  );
  assert.equal(editable.ownerUserId, OWNER);
  const ownerView = await calendarService.listEventsForActor(owner, {
    from: start - hourMs,
    to: start + 4 * hourMs,
  });
  assert.ok(
    ownerView.events.some(
      event => event.title === 'Added by collaborator' && !event.shared
    )
  );

  // Deleting the calendar detaches events and clears its grants.
  await calendarService.deleteCalendar(owner, calendar.id);
  assert.equal((await calendarService.listCalendars(friend)).length, 0);
  const grants = database
    .prepare(
      "SELECT COUNT(*) AS count FROM resource_grants WHERE resource_type = 'calendar'"
    )
    .get();
  assert.equal(grants.count, 0);
  const detached = database
    .prepare('SELECT calendar_id FROM calendar_events WHERE id = ?')
    .get(collaborative.event.id);
  assert.equal(detached.calendar_id, null);
});

test('ICS export and import round-trip events, recurrence, and reminders', async () => {
  const calendar = await calendarService.saveCalendar(owner, {
    name: 'Portability',
  });
  const start = new Date(2031, 6, 4, 12, 0).getTime();
  await calendarService.saveEventForActor(
    owner,
    {
      id: randomUUID(),
      title: 'Weekly sync; with, specials\nand a newline',
      notes: 'Agenda attached',
      startAt: start,
      endAt: start + hourMs,
      allDay: false,
      recurrence: { kind: 'weekly', dayOfWeek: 5, hour: 12, minute: 0 },
      reminderMinutes: 30,
      createdAt: now,
      updatedAt: now,
    },
    calendar.id
  );
  const exported = await calendarService.exportIcs(owner, calendar.id);
  assert.match(exported.content, /BEGIN:VCALENDAR/);
  assert.match(exported.content, /RRULE:FREQ=WEEKLY;BYDAY=FR/);
  assert.match(exported.content, /TRIGGER:-PT30M/);

  const target = await calendarService.saveCalendar(friend, {
    name: 'Imported',
  });
  const result = await calendarService.importIcs(
    friend,
    target.id,
    exported.content
  );
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 0);
  const imported = await calendarService.listEventsForActor(friend, {
    from: start - hourMs,
    to: start + hourMs,
  });
  const event = imported.events.find(entry =>
    entry.title.startsWith('Weekly sync')
  );
  assert.ok(event);
  assert.equal(event.title, 'Weekly sync; with, specials\nand a newline');
  assert.equal(event.notes, 'Agenda attached');
  assert.equal(event.startAt, start);
  assert.deepEqual(event.recurrence, {
    kind: 'weekly',
    dayOfWeek: 5,
    hour: 12,
    minute: 0,
  });
  assert.equal(event.reminderMinutes, 30);

  // Unsupported rules import the event but report the dropped rule.
  const exotic = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'SUMMARY:Every third day',
    'DTSTART:20310801T090000Z',
    'RRULE:FREQ=DAILY;INTERVAL=3',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const partial = await calendarService.importIcs(friend, target.id, exotic);
  assert.equal(partial.imported, 1);
  assert.equal(partial.droppedRules, 1);
});

test('reminders fire once per occurrence into the notification inbox', async () => {
  const start = Date.now() + 20 * 60 * 1000;
  const event = await calendarService.saveEventForActor(
    owner,
    {
      id: randomUUID(),
      title: 'Standup',
      startAt: start,
      allDay: false,
      reminderMinutes: 30,
      createdAt: now,
      updatedAt: now,
    },
    undefined
  );
  const fired = await calendarService.sweepReminders(Date.now());
  assert.ok(fired >= 1);
  // A second sweep never re-fires the same occurrence.
  assert.equal(await calendarService.sweepReminders(Date.now()), 0);
  const inbox = await notificationService.list(OWNER, {});
  const reminder = inbox.find(entry => entry.type === 'calendar-reminder');
  assert.ok(reminder);
  assert.match(reminder.title, /Standup/);
  assert.ok(event.event.id);
});

test('the model can list, create, and delete calendar events as its user', async () => {
  for (const name of [
    'list_calendar_events',
    'create_calendar_event',
    'delete_calendar_event',
  ]) {
    assert.ok(BUILTIN_TOOL_NAMES.includes(name), `${name} is registered`);
  }
  const start = new Date(2032, 0, 15, 10, 0).getTime();
  const created = await executeBuiltinTool(
    'create_calendar_event',
    { title: 'Model-made event', start_at: start },
    { actor: friend }
  );
  assert.equal(created.isError, false);
  const eventId = /id: ([0-9a-f-]+)/.exec(created.text)[1];

  const listed = await executeBuiltinTool(
    'list_calendar_events',
    { from: start - hourMs, to: start + hourMs },
    { actor: friend }
  );
  assert.match(listed.text, /Model-made event/);
  // Another user's tool call cannot see or delete it.
  const strangerList = await executeBuiltinTool(
    'list_calendar_events',
    { from: start - hourMs, to: start + hourMs },
    { actor: stranger }
  );
  assert.ok(!strangerList.text.includes('Model-made event'));
  const strangerDelete = await executeBuiltinTool(
    'delete_calendar_event',
    { event_id: eventId },
    { actor: stranger }
  );
  assert.equal(strangerDelete.isError, true);

  const deleted = await executeBuiltinTool(
    'delete_calendar_event',
    { event_id: eventId },
    { actor: friend }
  );
  assert.equal(deleted.isError, false);
});
