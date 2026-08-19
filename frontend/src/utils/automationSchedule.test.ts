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
import { test } from 'node:test';
import {
  describeTrigger,
  describeTriggers,
  isTriggerValid,
} from './automationSchedule';

const t = (key: string, options?: Record<string, unknown>) =>
  `${key}|${JSON.stringify(options ?? {})}`;

test('describeTrigger localizes every trigger kind through Intl', () => {
  const daily = describeTrigger(
    { kind: 'daily', hour: 8, minute: 5 },
    'en-US',
    t
  );
  assert.ok(daily.startsWith('automations.trigger.daily'));
  assert.ok(daily.includes('8:05'));

  const weekly = describeTrigger(
    { kind: 'weekly', dayOfWeek: 1, hour: 9, minute: 0 },
    'en-US',
    t
  );
  assert.ok(weekly.includes('Monday'));

  const yearly = describeTrigger(
    { kind: 'yearly', month: 6, dayOfMonth: 10, hour: 12, minute: 0 },
    'en-US',
    t
  );
  assert.ok(yearly.includes('June 10'));

  const hourlyWindowed = describeTrigger(
    { kind: 'hourly', minute: 15, startHour: 9, endHour: 17 },
    'en-US',
    t
  );
  assert.ok(hourlyWindowed.includes('(9–17)'));

  const joined = describeTriggers(
    [
      { kind: 'daily', hour: 8, minute: 0 },
      { kind: 'weekly', dayOfWeek: 5, hour: 17, minute: 30 },
    ],
    'en-US',
    t
  );
  assert.ok(joined.includes(' · '));
});

test('isTriggerValid mirrors the server bounds', () => {
  assert.ok(isTriggerValid({ kind: 'daily', hour: 0, minute: 0 }));
  assert.ok(!isTriggerValid({ kind: 'daily', hour: 24, minute: 0 }));
  assert.ok(
    !isTriggerValid({ kind: 'weekly', dayOfWeek: 7, hour: 1, minute: 0 })
  );
  assert.ok(
    isTriggerValid({ kind: 'monthly', dayOfMonth: 31, hour: 1, minute: 0 })
  );
  assert.ok(
    !isTriggerValid({ kind: 'monthly', dayOfMonth: 0, hour: 1, minute: 0 })
  );
  assert.ok(
    !isTriggerValid({ kind: 'hourly', minute: 0, startHour: 12, endHour: 9 })
  );
  assert.ok(
    isTriggerValid({
      kind: 'yearly',
      month: 2,
      dayOfMonth: 29,
      hour: 6,
      minute: 0,
    })
  );
});
