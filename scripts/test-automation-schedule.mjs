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
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const schedule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'automationSchedule.js')
  ).href
);
const { nextOccurrence, nextRunAt, occurrencesBetween, validateTriggers } =
  schedule;

const local = (...parts) => new Date(...parts).getTime();

test('every trigger kind yields the first occurrence strictly after the cursor', () => {
  // Daily: same-day when the time is still ahead, next day otherwise.
  const daily = { kind: 'daily', hour: 8, minute: 30 };
  const beforeBreakfast = local(2030, 5, 10, 7, 0);
  assert.equal(
    nextOccurrence(daily, beforeBreakfast),
    local(2030, 5, 10, 8, 30)
  );
  const afterBreakfast = local(2030, 5, 10, 9, 0);
  assert.equal(
    nextOccurrence(daily, afterBreakfast),
    local(2030, 5, 11, 8, 30)
  );
  // Exactly at the occurrence: strictly after, so it rolls forward.
  assert.equal(
    nextOccurrence(daily, local(2030, 5, 10, 8, 30)),
    local(2030, 5, 11, 8, 30)
  );

  // Weekly rollover across the week boundary.
  const weekly = { kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 };
  const monday = local(2030, 5, 3, 10, 0); // Monday June 3 2030, after 9am
  assert.equal(nextOccurrence(weekly, monday), local(2030, 5, 10, 9, 0));
  const sunday = local(2030, 5, 2, 12, 0);
  assert.equal(nextOccurrence(weekly, sunday), local(2030, 5, 3, 9, 0));

  // Monthly clamps day 31 to the shorter month's end.
  const monthly = { kind: 'monthly', dayOfMonth: 31, hour: 12, minute: 0 };
  const midApril = local(2030, 3, 15, 0, 0);
  assert.equal(nextOccurrence(monthly, midApril), local(2030, 3, 30, 12, 0));
  const lateApril = local(2030, 3, 30, 13, 0);
  assert.equal(nextOccurrence(monthly, lateApril), local(2030, 4, 31, 12, 0));

  // Yearly Feb 29 clamps to Feb 28 outside leap years.
  const yearly = {
    kind: 'yearly',
    month: 2,
    dayOfMonth: 29,
    hour: 6,
    minute: 0,
  };
  assert.equal(
    nextOccurrence(yearly, local(2030, 0, 1)),
    local(2030, 1, 28, 6, 0)
  );
  assert.equal(
    nextOccurrence(yearly, local(2032, 0, 1)),
    local(2032, 1, 29, 6, 0)
  );

  // Hourly respects its window and wraps to the next day's window start.
  const hourly = { kind: 'hourly', minute: 15, startHour: 9, endHour: 11 };
  assert.equal(
    nextOccurrence(hourly, local(2030, 5, 10, 9, 20)),
    local(2030, 5, 10, 10, 15)
  );
  assert.equal(
    nextOccurrence(hourly, local(2030, 5, 10, 11, 20)),
    local(2030, 5, 11, 9, 15)
  );

  // Once fires only while still in the future.
  const at = local(2030, 5, 10, 14, 0);
  assert.equal(nextOccurrence({ kind: 'once', at }, at - 1), at);
  assert.equal(nextOccurrence({ kind: 'once', at }, at), null);
});

test('multi-trigger schedules take the earliest occurrence and expand ranges', () => {
  const triggers = [
    { kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 },
    { kind: 'weekly', dayOfWeek: 4, hour: 17, minute: 30 },
  ];
  const sundayNight = local(2030, 5, 2, 22, 0);
  assert.equal(nextRunAt(triggers, sundayNight), local(2030, 5, 3, 9, 0));
  const mondayNoon = local(2030, 5, 3, 12, 0);
  assert.equal(nextRunAt(triggers, mondayNoon), local(2030, 5, 6, 17, 30));

  const occurrences = occurrencesBetween(
    triggers,
    local(2030, 5, 2),
    local(2030, 5, 16)
  );
  assert.deepEqual(occurrences, [
    local(2030, 5, 3, 9, 0),
    local(2030, 5, 6, 17, 30),
    local(2030, 5, 10, 9, 0),
    local(2030, 5, 13, 17, 30),
  ]);
  // Occurrences are strictly ascending and capped.
  const capped = occurrencesBetween(
    [{ kind: 'hourly', minute: 0 }],
    local(2030, 5, 1),
    local(2030, 8, 1),
    10
  );
  assert.equal(capped.length, 10);

  // Exhausted schedules return null.
  assert.equal(
    nextRunAt([{ kind: 'once', at: local(2030, 0, 1) }], local(2030, 6, 1)),
    null
  );
});

test('trigger validation rejects malformed input and normalizes fields', () => {
  assert.throws(() => validateTriggers([]), /at least one trigger/i);
  assert.throws(() => validateTriggers('daily'), /at least one trigger/i);
  assert.throws(
    () =>
      validateTriggers([{ kind: 'weekly', dayOfWeek: 7, hour: 9, minute: 0 }]),
    /weekly trigger/i
  );
  assert.throws(
    () =>
      validateTriggers([
        { kind: 'monthly', dayOfMonth: 0, hour: 9, minute: 0 },
      ]),
    /monthly trigger/i
  );
  assert.throws(
    () =>
      validateTriggers([
        { kind: 'hourly', minute: 0, startHour: 12, endHour: 9 },
      ]),
    /endHour/i
  );
  assert.throws(
    () => validateTriggers([{ kind: 'sometimes' }]),
    /unknown trigger kind/i
  );
  const normalized = validateTriggers([
    { kind: 'daily', hour: 7, minute: 45, extra: 'dropped' },
  ]);
  assert.deepEqual(normalized, [{ kind: 'daily', hour: 7, minute: 45 }]);
  assert.throws(
    () =>
      validateTriggers(
        Array.from({ length: 6 }, () => ({ kind: 'daily', hour: 1, minute: 0 }))
      ),
    /at most 5/i
  );
});

test('DST transition days still fire at the local wall-clock time', () => {
  // US DST spring forward 2030-03-10 and fall back 2030-11-03 (only
  // meaningful in a DST timezone; in fixed-offset zones this still holds).
  const daily = { kind: 'daily', hour: 9, minute: 0 };
  const springForwardEve = local(2030, 2, 9, 10, 0);
  const next = nextOccurrence(daily, springForwardEve);
  const nextDate = new Date(next);
  assert.equal(nextDate.getHours(), 9);
  assert.equal(nextDate.getMinutes(), 0);
  assert.equal(nextDate.getDate(), 10);
  const fallBackEve = local(2030, 10, 2, 10, 0);
  const fallNext = new Date(nextOccurrence(daily, fallBackEve));
  assert.equal(fallNext.getHours(), 9);
  assert.equal(fallNext.getDate(), 3);
});
