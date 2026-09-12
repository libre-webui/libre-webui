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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

type SummaryRequest = {
  model: string;
  thinking: string;
  providerType?: string;
  providerId?: string;
};
type ReasoningHarness = {
  ready: boolean;
  push: (thinking: string) => void;
  finish: () => void;
};
const firstThought =
  'First I need to understand the project requirements, identify the relevant files, and check how existing components behave before choosing an implementation that fits the application. ';
const nextThought =
  'Now I am comparing the implementation tradeoffs and checking the edge cases. ';
const firstSummary = 'Understanding the project requirements';
const secondSummary = 'Checking the implementation tradeoffs';

async function prepareReasoning(
  page: Page,
  options: {
    disabled?: boolean;
    private?: boolean;
    language?: 'en' | 'ar';
  } = {}
) {
  await page.clock.install({ time: new Date('2026-09-12T12:00:00Z') });
  const titleSettings = {
    autoTitle: !options.disabled,
    taskModel: 'summary-model',
    taskProviderType: 'plugin' as const,
    taskProviderId: 'summary-provider',
  };
  const session = {
    id: 'thinking-session',
    title: 'Reasoning checks',
    model: 'llama3.2:3b',
    isPrivate: options.private ?? false,
    messages: [],
    createdAt: 1,
    updatedAt: 1,
  };
  await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: {
      titleSettings,
      theme: {
        mode: options.language === 'ar' ? 'dark' : 'light',
        accent: 'blue',
        adaptToAccent: false,
        customAccent: '#2563eb',
      },
    },
  });
  await page.addInitScript(language => {
    localStorage.setItem('i18nextLng', language);
  }, options.language ?? 'en');
  await page.goto('/c/thinking-session');
  await expect(page.locator('textarea[rows="1"][dir="auto"]')).toBeVisible();
  if ((page.viewportSize()?.width ?? 1280) < 640) {
    await page.getByTestId('sidebar-toggle-size').click();
    await expect
      .poll(
        async () =>
          (await page.getByTestId('sidebar').boundingBox())?.width ?? 0
      )
      .toBeLessThan(100);
  }
  await page.clock.pauseAt(new Date('2026-09-12T12:01:00Z'));
  await page.evaluate(() => {
    const testWindow = window as unknown as {
      reasoningHarness: ReasoningHarness;
    };
    const attach = (
      messageId: string,
      publish: (event: Record<string, unknown>) => void,
      close: () => void
    ) => {
      let accumulated = '';
      testWindow.reasoningHarness = {
        ready: true,
        push(thinking) {
          accumulated += thinking;
          publish({
            type: 'chunk',
            messageId,
            content: '',
            total: '',
            thinking,
            thinkingTotal: accumulated,
            done: false,
          });
        },
        finish() {
          publish({
            type: 'done',
            messageId,
            role: 'assistant',
            content: 'The final answer is ready.',
            thinking: accumulated,
            timestamp: Date.now(),
          });
          close();
        },
      };
    };
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        window.location.href
      );
      if (
        !/^\/api\/chat\/sessions\/[^/]+\/events$/.test(url.pathname) ||
        !url.searchParams.has('generation')
      ) {
        return originalFetch(input, init);
      }
      let ended = false;
      let cursor = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            attach(
              url.searchParams.get('generation')!,
              event => {
                if (ended) return;
                controller.enqueue(
                  new TextEncoder().encode(
                    `id: ${++cursor}\ndata: ${JSON.stringify(event)}\n\n`
                  )
                );
              },
              () => {
                ended = true;
                controller.close();
              }
            );
            init?.signal?.addEventListener(
              'abort',
              () => {
                if (ended) return;
                ended = true;
                controller.error(new DOMException('Aborted', 'AbortError'));
              },
              { once: true }
            );
          },
          cancel() {
            ended = true;
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    };
    // Private chats use the existing mock WebSocket rather than durable jobs.
    const originalSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function (data) {
      const message = typeof data === 'string' ? JSON.parse(data) : {};
      if (message.type !== 'chat_stream') return originalSend.call(this, data);
      attach(
        message.data.assistantMessageId,
        event => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type:
                  event.type === 'done'
                    ? 'assistant_complete'
                    : 'assistant_chunk',
                data: event,
              }),
            })
          );
        },
        () => {}
      );
    };
  });
}

async function startReasoning(
  page: Page,
  text = 'Explain the project carefully'
) {
  await page.evaluate(() => {
    const harness = (
      window as unknown as { reasoningHarness?: ReasoningHarness }
    ).reasoningHarness;
    if (harness) harness.ready = false;
  });
  const input = page.locator('textarea[rows="1"][dir="auto"]');
  await input.fill(text);
  await input.press('Enter');
  await page.clock.runFor(32);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { reasoningHarness?: ReasoningHarness })
            .reasoningHarness?.ready ?? false
      )
    )
    .toBe(true);
}

async function pushThinking(page: Page, thought: string) {
  await page.evaluate(thought => {
    (
      window as unknown as { reasoningHarness: ReasoningHarness }
    ).reasoningHarness.push(thought);
  }, thought);
  await page.clock.runFor(300);
}

test('collapsed topics update from serialized requests using the latest bounded reasoning', async ({
  page,
}, testInfo) => {
  await prepareReasoning(page);
  const requests: SummaryRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  await page.route(
    '**/api/chat/sessions/thinking-session/summarize-thinking',
    async route => {
      requests.push(route.request().postDataJSON());
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const number = requests.length;
      if (number === 1) await firstResponse;
      await route.fulfill({
        json: {
          success: true,
          data: { summary: number === 1 ? firstSummary : secondSummary },
        },
      });
      inFlight -= 1;
    }
  );
  await startReasoning(page);
  const summary = page.getByTestId('thinking-summary');
  const toggle = page.getByTestId('thinking-toggle');
  const raw = page.getByTestId('thinking-content');
  try {
    await pushThinking(page, firstThought);
    await page.clock.runFor(1000);
    await expect.poll(() => requests.length).toBe(1);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(raw).toBeHidden();
    await expect(
      page.getByTestId('thinking-generation-indicator')
    ).toBeVisible();
    expect(requests[0]).toEqual({
      model: 'summary-model',
      thinking: firstThought.trim(),
      providerType: 'plugin',
      providerId: 'summary-provider',
    });
    await pushThinking(page, nextThought.repeat(100));
    await page.clock.runFor(6000);
    expect(requests).toHaveLength(1);
    releaseFirst();
    await expect(summary).toHaveText(firstSummary);
    await page.screenshot({
      path: testInfo.outputPath('thinking-summary-desktop.png'),
      animations: 'disabled',
    });
    await page.clock.runFor(6000);
    await expect.poll(() => requests.length).toBe(2);
    await expect(summary).toHaveText(secondSummary);
    const latest = (firstThought + nextThought.repeat(100)).slice(-4000).trim();
    expect(requests[1].thinking).toBe(latest);
    expect(maxInFlight).toBe(1);
    await page.clock.runFor(12_000);
    expect(requests).toHaveLength(2);
    await toggle.click();
    await expect(raw).toBeVisible();
    await expect(raw).toContainText(firstThought.trim());
    await expect(raw).toContainText(nextThought.trim());
    await page.evaluate(() =>
      (
        window as unknown as { reasoningHarness: ReasoningHarness }
      ).reasoningHarness.finish()
    );
    await page.clock.runFor(300);
    await expect(
      page.getByText('The final answer is ready.', { exact: true })
    ).toBeVisible();
    await expect(summary).toHaveText(secondSummary);
    await expect(page.getByTestId('thinking-generation-indicator')).toHaveCount(
      0
    );
    await page.clock.runFor(12_000);
    expect(requests).toHaveLength(2);
  } finally {
    releaseFirst();
  }
});

test('brief thoughts wait for more text and changing thoughts respect the five-second interval', async ({
  page,
}) => {
  await prepareReasoning(page);
  let requests = 0;
  await page.route(
    '**/api/chat/sessions/thinking-session/summarize-thinking',
    route => {
      requests += 1;
      return route.fulfill({
        json: {
          success: true,
          data: { summary: requests === 1 ? firstSummary : secondSummary },
        },
      });
    }
  );
  await startReasoning(page);
  await pushThinking(page, firstThought.slice(0, 30));
  await page.clock.runFor(1000);
  expect(requests).toBe(0);
  await pushThinking(page, firstThought.slice(30));
  await page.clock.runFor(1000);
  await expect(page.getByTestId('thinking-summary')).toHaveText(firstSummary);
  expect(requests).toBe(1);
  await pushThinking(page, nextThought.repeat(3));
  await page.clock.runFor(3000);
  expect(requests).toBe(1);
  await page.clock.runFor(1500);
  await expect(page.getByTestId('thinking-summary')).toHaveText(secondSummary);
  expect(requests).toBe(2);
});

test('Stop discards a delayed summary and a new reply starts with a fresh topic', async ({
  page,
}) => {
  await prepareReasoning(page);
  let requests = 0;
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>(resolve => {
    releaseFirst = resolve;
  });
  await page.route(
    '**/api/chat/sessions/thinking-session/summarize-thinking',
    async route => {
      const number = ++requests;
      if (number === 1) await firstResponse;
      await route.fulfill({
        json: {
          success: true,
          data: {
            summary: number === 1 ? 'Stale cancelled summary' : secondSummary,
          },
        },
      });
    }
  );
  try {
    await startReasoning(page);
    await pushThinking(page, firstThought);
    await page.clock.runFor(6000);
    await expect.poll(() => requests).toBe(1);
    await page.getByTitle('Stop generation').click();
    await page.clock.runFor(12_000);
    expect(requests).toBe(1);
    await expect(page.getByTestId('thinking-summary')).toHaveCount(0);
    await startReasoning(page, 'Now explain a different topic');
    await pushThinking(page, nextThought.repeat(3));
    await page.clock.runFor(6000);
    await expect.poll(() => requests).toBe(2);
    await expect(page.getByTestId('thinking-summary')).toHaveText(
      secondSummary
    );
    releaseFirst();
    await page.clock.runFor(6000);
    await expect(page.getByTestId('thinking-summary')).toHaveText(
      secondSummary
    );
    await expect(page.getByText('Stale cancelled summary')).toHaveCount(0);
    await page.getByTitle('Stop generation').click();
    await page.clock.runFor(12_000);
    expect(requests).toBe(2);
  } finally {
    releaseFirst();
  }
});

for (const excluded of ['disabled', 'private'] as const) {
  test(`${excluded} chats keep raw reasoning without sending summary requests`, async ({
    page,
  }) => {
    await prepareReasoning(page, {
      disabled: excluded === 'disabled',
      private: excluded === 'private',
    });
    const requests: SummaryRequest[] = [];
    await page.route(
      '**/api/chat/sessions/*/summarize-thinking',
      async route => {
        requests.push(route.request().postDataJSON());
        await route.fulfill({
          json: { success: true, data: { summary: 'Unexpected summary' } },
        });
      }
    );
    await startReasoning(page);
    await pushThinking(page, firstThought);
    await page.clock.runFor(12_000);
    await expect(page.getByTestId('thinking-summary')).toContainText(
      'Thinking'
    );
    await page.getByTestId('thinking-toggle').click();
    await expect(page.getByTestId('thinking-content')).toContainText(
      firstThought.trim()
    );
    expect(requests).toHaveLength(0);
  });
}

test('Arabic summaries fit a narrow screen and respect reduced motion', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await prepareReasoning(page, { language: 'ar' });
  const text = 'مراجعة متطلبات المشروع ومقارنة خيارات التنفيذ المناسبة';
  await page.route('**/api/chat/sessions/*/summarize-thinking', route =>
    route.fulfill({ json: { success: true, data: { summary: text } } })
  );
  await startReasoning(page);
  await pushThinking(page, firstThought);
  await page.clock.runFor(6000);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const summary = page.getByTestId('thinking-summary');
  const toggle = page.getByTestId('thinking-toggle');
  await expect(summary).toHaveText(text);
  await expect(summary).toHaveCSS('animation-name', 'none');
  await toggle.click();
  await expect(page.getByTestId('thinking-content')).toBeVisible();
  await toggle.click();
  await expect(page.getByTestId('thinking-content')).toBeHidden();
  const bounds = await toggle.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  await page.screenshot({
    path: testInfo.outputPath('thinking-summary-ar-mobile.png'),
  });
});
