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

/** Human-readable trigger summaries. Names come from Intl, not the catalog. */

import type { AutomationTrigger } from '@/types';

const timeText = (hour: number, minute: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(2024, 0, 1, hour, minute));

const weekdayText = (dayOfWeek: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(
    // 2024-01-07 is a Sunday.
    new Date(2024, 0, 7 + dayOfWeek)
  );

const monthDayText = (
  month: number,
  dayOfMonth: number,
  locale: string
): string =>
  new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(
    new Date(2024, month - 1, dayOfMonth)
  );

/**
 * One trigger as `label` (translated kind) + `detail` (Intl-formatted when).
 * The caller supplies the translator so the catalog stays with the UI.
 */
export function describeTrigger(
  trigger: AutomationTrigger,
  locale: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  switch (trigger.kind) {
    case 'once':
      return t('automations.trigger.once', {
        when: new Intl.DateTimeFormat(locale, {
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(new Date(trigger.at)),
      });
    case 'hourly': {
      const window =
        trigger.startHour !== undefined || trigger.endHour !== undefined
          ? ` (${trigger.startHour ?? 0}–${trigger.endHour ?? 23})`
          : '';
      return (
        t('automations.trigger.hourly', {
          minute: String(trigger.minute).padStart(2, '0'),
        }) + window
      );
    }
    case 'daily':
      return t('automations.trigger.daily', {
        time: timeText(trigger.hour, trigger.minute, locale),
      });
    case 'weekly':
      return t('automations.trigger.weekly', {
        day: weekdayText(trigger.dayOfWeek, locale),
        time: timeText(trigger.hour, trigger.minute, locale),
      });
    case 'monthly':
      return t('automations.trigger.monthly', {
        day: trigger.dayOfMonth,
        time: timeText(trigger.hour, trigger.minute, locale),
      });
    case 'yearly':
      return t('automations.trigger.yearly', {
        date: monthDayText(trigger.month, trigger.dayOfMonth, locale),
        time: timeText(trigger.hour, trigger.minute, locale),
      });
  }
}

export function describeTriggers(
  triggers: AutomationTrigger[],
  locale: string,
  t: (key: string, options?: Record<string, unknown>) => string
): string {
  return triggers
    .map(trigger => describeTrigger(trigger, locale, t))
    .join(' · ');
}

/** A minimal client-side validity check mirroring the server's rules. */
export function isTriggerValid(trigger: AutomationTrigger): boolean {
  const int = (value: unknown, min: number, max: number): boolean =>
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max;
  switch (trigger.kind) {
    case 'once':
      return int(trigger.at, 0, 8.64e15);
    case 'hourly':
      return (
        int(trigger.minute, 0, 59) &&
        (trigger.startHour === undefined || int(trigger.startHour, 0, 23)) &&
        (trigger.endHour === undefined || int(trigger.endHour, 0, 23)) &&
        (trigger.startHour === undefined ||
          trigger.endHour === undefined ||
          trigger.endHour >= trigger.startHour)
      );
    case 'daily':
      return int(trigger.hour, 0, 23) && int(trigger.minute, 0, 59);
    case 'weekly':
      return (
        int(trigger.dayOfWeek, 0, 6) &&
        int(trigger.hour, 0, 23) &&
        int(trigger.minute, 0, 59)
      );
    case 'monthly':
      return (
        int(trigger.dayOfMonth, 1, 31) &&
        int(trigger.hour, 0, 23) &&
        int(trigger.minute, 0, 59)
      );
    case 'yearly':
      return (
        int(trigger.month, 1, 12) &&
        int(trigger.dayOfMonth, 1, 31) &&
        int(trigger.hour, 0, 23) &&
        int(trigger.minute, 0, 59)
      );
    default:
      return false;
  }
}
