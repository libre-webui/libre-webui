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

/**
 * Local-timezone date grid math for the calendar views. Weekday/month names
 * come from Intl so no locale catalog entries are needed.
 */

export const startOfDay = (date: Date): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate());

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

export const isSameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

/** 0 = Sunday. The grid uses a fixed Sunday start for every locale. */
export const startOfWeek = (date: Date): Date =>
  addDays(startOfDay(date), -date.getDay());

/**
 * The 6x7 day matrix shown for a month: starts on the Sunday at or before
 * the 1st, always 42 cells so the grid height never jumps.
 */
export function gridDaysForMonth(year: number, monthIndex: number): Date[] {
  const first = new Date(year, monthIndex, 1);
  const start = startOfWeek(first);
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

/** The 7 days of the week containing `date`, starting Sunday. */
export function weekDays(date: Date): Date[] {
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export const monthLabel = (
  year: number,
  monthIndex: number,
  locale: string
): string =>
  new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
    new Date(year, monthIndex, 1)
  );

export const weekdayLabels = (
  locale: string,
  width: 'short' | 'narrow' = 'short'
): string[] => {
  const formatter = new Intl.DateTimeFormat(locale, { weekday: width });
  const sunday = startOfWeek(new Date(2024, 0, 7));
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(addDays(sunday, index))
  );
};

export const timeLabel = (timestamp: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(timestamp));

/** yyyy-mm-dd for a native date input, in local time. */
export const toDateInputValue = (timestamp: number): string => {
  const date = new Date(timestamp);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

/** HH:mm for a native time input, in local time. */
export const toTimeInputValue = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes()
  ).padStart(2, '0')}`;
};

/** Combine native date + time input values into a local epoch-ms timestamp. */
export function fromInputValues(dateValue: string, timeValue: string): number {
  const [year, month, day] = dateValue.split('-').map(Number);
  const [hour, minute] = (timeValue || '00:00').split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute).getTime();
}
