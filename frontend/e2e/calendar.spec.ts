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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

type MockEvent = {
  id: string;
  title: string;
  notes?: string;
  startAt: number;
  endAt?: number;
  allDay: boolean;
  createdAt: number;
  updatedAt: number;
};

const today = new Date();
const seededEvent: MockEvent = {
  id: 'seeded-event',
  title: 'Quarterly planning',
  startAt: new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    14,
    0
  ).getTime(),
  allDay: false,
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_000_000,
};

async function mockCalendarApi(page: Page, initialEvents: MockEvent[]) {
  const events = structuredClone(initialEvents);

  await page.route(
    /\/api\/calendar\/events(?:\/[^/?]+)?(?:\?.*)?$/,
    async route => {
      const request = route.request();
      const method = request.method();

      if (method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: events }),
        });
        return;
      }

      if (method === 'POST') {
        const body = request.postDataJSON() as Partial<MockEvent>;
        const created: MockEvent = {
          id: `event-${events.length + 1}`,
          title: body.title ?? '',
          startAt: body.startAt ?? Date.now(),
          allDay: Boolean(body.allDay),
          createdAt: 1_770_000_001_000,
          updatedAt: 1_770_000_001_000,
        };
        events.push(created);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: created }),
        });
        return;
      }

      await route.fulfill({
        status: 405,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Method not allowed' }),
      });
    }
  );

  await page.route(/\/api\/automations(?:\/.*)?(?:\?.*)?$/, async route => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/runs/summary')
      ? { unseenCount: 0, days: [] }
      : [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data }),
    });
  });
}

test('the calendar shows events in the month grid and creates new ones', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockCalendarApi(page, [seededEvent]);

  await page.goto('/calendar');
  await expect(page.getByTestId('calendar-month-grid')).toBeVisible();
  await expect(
    page
      .getByTestId('calendar-event-chip')
      .filter({ hasText: seededEvent.title })
  ).toBeVisible();

  // Create an event from the header action.
  await page.getByTestId('calendar-new-event').click();
  await expect(page.getByTestId('calendar-event-modal')).toBeVisible();
  await page.getByTestId('calendar-event-title').fill('Dentist visit');
  await page.getByTestId('calendar-event-save').click();
  await expect(page.getByTestId('calendar-event-modal')).toHaveCount(0);
  await expect(
    page.getByTestId('calendar-event-chip').filter({ hasText: 'Dentist visit' })
  ).toBeVisible();

  // The week view renders the same events in hour rows.
  await page.getByTestId('calendar-view-week').click();
  await expect(page.getByTestId('calendar-week-grid')).toBeVisible();
  await expect(
    page
      .getByTestId('calendar-event-chip')
      .filter({ hasText: seededEvent.title })
  ).toBeVisible();
});
