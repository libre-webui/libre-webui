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
  addDays,
  fromInputValues,
  gridDaysForMonth,
  isSameDay,
  startOfWeek,
  toDateInputValue,
  toTimeInputValue,
  weekDays,
  weekdayLabels,
} from './calendarDates';

test('gridDaysForMonth always yields 42 cells starting on Sunday', () => {
  // June 2030 starts on a Saturday.
  const days = gridDaysForMonth(2030, 5);
  assert.equal(days.length, 42);
  assert.equal(days[0].getDay(), 0);
  assert.ok(days[0].getTime() <= new Date(2030, 5, 1).getTime());
  // Contiguous days.
  for (let index = 1; index < days.length; index += 1) {
    assert.ok(isSameDay(days[index], addDays(days[index - 1], 1)));
  }
  // The 1st of the month is in the first week.
  assert.ok(days.slice(0, 7).some(day => isSameDay(day, new Date(2030, 5, 1))));
});

test('weekDays returns the Sunday-anchored week containing the date', () => {
  const wednesday = new Date(2030, 5, 12);
  const days = weekDays(wednesday);
  assert.equal(days.length, 7);
  assert.equal(days[0].getDay(), 0);
  assert.ok(days.some(day => isSameDay(day, wednesday)));
  assert.ok(startOfWeek(wednesday).getTime() === days[0].getTime());
});

test('date and time input values round-trip through local time', () => {
  const timestamp = new Date(2030, 11, 31, 23, 5).getTime();
  const dateValue = toDateInputValue(timestamp);
  const timeValue = toTimeInputValue(timestamp);
  assert.equal(dateValue, '2030-12-31');
  assert.equal(timeValue, '23:05');
  assert.equal(fromInputValues(dateValue, timeValue), timestamp);
  // Missing time collapses to midnight.
  assert.equal(
    fromInputValues('2030-01-02', ''),
    new Date(2030, 0, 2).getTime()
  );
});

test('weekdayLabels localizes seven names starting with Sunday', () => {
  const labels = weekdayLabels('en-US');
  assert.equal(labels.length, 7);
  assert.equal(labels[0], 'Sun');
  assert.equal(labels[6], 'Sat');
});
