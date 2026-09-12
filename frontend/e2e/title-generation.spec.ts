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

const session = {
  id: 'title-session',
  title: 'New Chat',
  model: 'llama3.2:3b',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
};

async function holdReplyCompletion(page: Page) {
  await page.evaluate(() => {
    const originalFetch = window.fetch.bind(window);
    const completion = new Promise<void>(resolve => {
      (
        window as unknown as { releaseReplyCompletion: () => void }
      ).releaseReplyCompletion = resolve;
    });
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        window.location.href
      );
      if (!url.pathname.endsWith('/events') || !response.body) return response;
      return new Response(
        response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            async transform(chunk, controller) {
              // The mock emits each SSE event as one chunk. Leave content
              // flowing while holding its final completion event for the test.
              if (new TextDecoder().decode(chunk).includes('"type":"done"')) {
                await completion;
              }
              controller.enqueue(chunk);
            },
          })
        ),
        { status: response.status, headers: response.headers }
      );
    };
  });
  return () =>
    page.evaluate(() => {
      (
        window as unknown as { releaseReplyCompletion: () => void }
      ).releaseReplyCompletion();
    });
}

test('the first message gets its title while the assistant is still responding', async ({
  page,
}) => {
  const titleSettings = {
    autoTitle: true,
    taskModel: 'title-model',
    taskProviderType: 'plugin' as const,
    taskProviderId: 'title-provider',
  };
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: { titleSettings },
    generatedTitle: {
      title: 'Title Before Reply Completion',
      source: 'plugin',
    },
    chatStream: {
      chunks: ['The assistant is still composing its response.'],
      duplicateCompletion: true,
    },
  });
  await page.goto('/c/title-session');
  const input = page.getByRole('textbox', { name: 'Send a message' });
  await expect(input).toBeVisible();
  const releaseReply = await holdReplyCompletion(page);
  try {
    await input.fill('Explain this while naming the conversation');
    await input.press('Enter');
    await expect(
      page.getByText('The assistant is still composing its response.', {
        exact: true,
      })
    ).toBeVisible();
    await expect(page.getByTitle('Stop generation')).toBeVisible();
    await expect(
      page
        .getByTestId('sidebar-session-scroll-region')
        .getByText('Title Before Reply Completion', { exact: true })
    ).toBeVisible();
    await expect(page.getByTitle('Stop generation')).toBeVisible();
    expect(mockApi.titleGenerationRequests).toEqual([
      {
        sessionId: session.id,
        model: 'title-model',
        message: 'Explain this while naming the conversation',
        providerType: 'plugin',
        providerId: 'title-provider',
      },
    ]);
  } finally {
    await releaseReply();
  }
  await expect(page.getByTitle('Stop generation')).toHaveCount(0);
  await input.fill('Explain one more detail');
  await input.press('Enter');
  await expect(
    page.getByText('The assistant is still composing its response.', {
      exact: true,
    })
  ).toHaveCount(2);
  await expect(page.getByTitle('Stop generation')).toHaveCount(0);
  expect(mockApi.titleGenerationRequests).toHaveLength(1);
  expect(mockApi.sessionUpdateRequests).toHaveLength(0);
});

test('a slow title request does not delay replies or duplicate on the next turn', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: {
      titleSettings: { autoTitle: true, taskModel: 'llama3.2:3b' },
    },
    generatedTitle: { title: 'Slow Title Result', source: 'ollama' },
  });
  let titleRequests = 0;
  let releaseTitle!: () => void;
  const titleResponse = new Promise<void>(resolve => {
    releaseTitle = resolve;
  });
  await page.route(
    '**/api/chat/sessions/title-session/generate-title',
    async route => {
      titleRequests += 1;
      await titleResponse;
      await route.fallback();
    }
  );
  await page.goto('/c/title-session');
  const input = page.getByRole('textbox', { name: 'Send a message' });
  await expect(input).toBeVisible();
  try {
    await input.fill('Start the response without waiting for its title');
    await input.press('Enter');
    await expect.poll(() => titleRequests).toBe(1);
    await expect(
      page.getByText('Mock assistant response', { exact: true })
    ).toBeVisible();
    await expect(page.getByTitle('Stop generation')).toHaveCount(0);
    await input.fill('Continue while title generation is pending');
    await input.press('Enter');
    await expect(
      page.getByText('Mock assistant response', { exact: true })
    ).toHaveCount(2);
    await expect(page.getByTitle('Stop generation')).toHaveCount(0);
    expect(titleRequests).toBe(1);
    expect(mockApi.titleGenerationRequests).toHaveLength(0);
  } finally {
    releaseTitle();
  }
  await expect(
    page
      .getByTestId('sidebar-session-scroll-region')
      .getByText('Slow Title Result', { exact: true })
  ).toBeVisible();
  expect(mockApi.titleGenerationRequests).toHaveLength(1);
  expect(mockApi.sessionUpdateRequests).toHaveLength(0);
});

for (const snapshotSource of [
  'completion replay',
  'failed regeneration',
] as const) {
  test(`an older ${snapshotSource} snapshot cannot replace a newly generated title`, async ({
    page,
  }) => {
    const mockApi = await mockLibreWebUiApi(page, {
      sessions: [session],
      preferences: {
        titleSettings: { autoTitle: true, taskModel: 'llama3.2:3b' },
      },
      generatedTitle: { title: 'Keep This New Title', source: 'ollama' },
      chatStream: {
        chunks: ['The streamed response is complete.'],
        duplicateCompletion: snapshotSource === 'completion replay',
      },
    });
    let releaseTitle!: () => void;
    let releaseSnapshot!: () => void;
    const titleResponse = new Promise<void>(resolve => {
      releaseTitle = resolve;
    });
    const snapshotResponse = new Promise<void>(resolve => {
      releaseSnapshot = resolve;
    });
    let snapshotRequested = false;
    await page.route(
      '**/api/chat/sessions/title-session/generate-title',
      async route => {
        await titleResponse;
        await route.fallback();
      }
    );
    await page.route('**/api/chat/sessions/title-session', async route => {
      if (route.request().method() !== 'GET') {
        await route.fallback();
        return;
      }
      const generation = await page.evaluate(() => {
        return (
          window as unknown as {
            __libreChatStreams: Array<{
              userMessageId: string;
              assistantMessageId: string;
              message: string;
            }>;
          }
        ).__libreChatStreams[0];
      });
      const oldSnapshot = {
        ...session,
        updatedAt: Date.now(),
        messages: [
          {
            id: generation.userMessageId,
            role: 'user',
            content: generation.message,
            timestamp: Date.now(),
          },
          {
            id: generation.assistantMessageId,
            role: 'assistant',
            content: 'The authoritative reply has now been recovered.',
            timestamp: Date.now(),
          },
        ],
      };
      snapshotRequested = true;
      await snapshotResponse;
      await route.fulfill({ json: { success: true, data: oldSnapshot } });
    });
    await page.goto('/c/title-session');
    const input = page.getByRole('textbox', { name: 'Send a message' });
    await expect(input).toBeVisible();
    await page.evaluate(snapshotSource => {
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
          snapshotSource === 'failed regeneration' &&
          url.pathname.endsWith('/generations') &&
          JSON.parse(String(init?.body ?? '{}')).regenerate === true
        ) {
          return new Response(
            JSON.stringify({ success: false, error: 'Regeneration rejected' }),
            {
              status: 409,
              headers: { 'content-type': 'application/json' },
            }
          );
        }
        const response = await originalFetch(input, init);
        if (snapshotSource !== 'completion replay') return response;
        if (!url.pathname.endsWith('/events') || !response.body)
          return response;
        return new Response(
          response.body.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, controller) {
                // A late replay of a truncated completion reloads SQL state.
                const event = new TextDecoder()
                  .decode(chunk)
                  .replaceAll(
                    '"type":"done"',
                    '"type":"done","truncated":true'
                  );
                controller.enqueue(new TextEncoder().encode(event));
              },
            })
          ),
          { status: response.status, headers: response.headers }
        );
      };
    }, snapshotSource);
    const title = page
      .getByTestId('sidebar-session-scroll-region')
      .getByText('Keep This New Title', { exact: true });
    try {
      await input.fill('Generate a title while the completion snapshot loads');
      await input.press('Enter');
      if (snapshotSource === 'failed regeneration') {
        await expect(
          page.getByText('The streamed response is complete.', { exact: true })
        ).toBeVisible();
        await expect(page.getByTitle('Stop generation')).toHaveCount(0);
        expect(snapshotRequested).toBe(false);
        await page.getByTitle('Regenerate response').click();
      }
      await expect.poll(() => snapshotRequested).toBe(true);
      releaseTitle();
      await expect(title).toBeVisible();
      releaseSnapshot();
      await expect(
        page.getByText('The authoritative reply has now been recovered.', {
          exact: true,
        })
      ).toBeVisible();
      await expect(title).toBeVisible();
      expect(mockApi.titleGenerationRequests).toHaveLength(1);
      expect(mockApi.sessionUpdateRequests).toHaveLength(0);
    } finally {
      releaseTitle();
      releaseSnapshot();
    }
  });
}

for (const exclusion of [
  'disabled',
  'custom title',
  'private',
  'no task model',
] as const) {
  test(`automatic titles remain excluded for ${exclusion}`, async ({
    page,
  }) => {
    const excludedSession = {
      ...session,
      title: exclusion === 'custom title' ? 'My chosen title' : session.title,
      isPrivate: exclusion === 'private',
    };
    const mockApi = await mockLibreWebUiApi(page, {
      sessions: [excludedSession],
      preferences: {
        titleSettings: {
          autoTitle: exclusion !== 'disabled',
          taskModel: exclusion === 'no task model' ? '' : 'llama3.2:3b',
        },
      },
    });
    await page.goto('/c/title-session');
    const input = page.getByRole('textbox', { name: 'Send a message' });
    await expect(input).toBeVisible();
    await input.fill('Respond without changing this conversation title');
    await input.press('Enter');
    await expect(
      page.getByText('Mock assistant response', { exact: true })
    ).toBeVisible();
    await expect(page.getByTitle('Stop generation')).toHaveCount(0);
    expect(mockApi.titleGenerationRequests).toHaveLength(0);
    expect(mockApi.sessionUpdateRequests).toHaveLength(0);
  });
}

test('generated title immediately replaces the sidebar preview without a duplicate update', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: {
      titleSettings: {
        autoTitle: true,
        taskModel: 'llama3.2:3b',
      },
    },
    generatedTitle: {
      title: 'Persistent Sidebar Summary',
      source: 'ollama',
    },
  });

  await page.goto('/c/title-session');
  const messageInput = page.getByRole('textbox', { name: 'Send a message' });
  await expect(messageInput).toBeVisible();
  await expect(
    page
      .getByTestId('sidebar-session-scroll-region')
      .getByRole('button', { name: 'New Chat', exact: true })
  ).toBeVisible();

  await messageInput.fill('Explain why the generated title should update');
  await messageInput.press('Enter');

  await expect(
    page
      .getByTestId('sidebar-session-scroll-region')
      .getByText('Persistent Sidebar Summary', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Chat title generated', { exact: true })
  ).toBeVisible();
  await expect.poll(() => mockApi.titleGenerationRequests.length).toBe(1);

  expect(mockApi.titleGenerationRequests[0]).toEqual({
    sessionId: 'title-session',
    model: 'llama3.2:3b',
    message: 'Explain why the generated title should update',
  });
  expect(mockApi.sessionUpdateRequests).toHaveLength(0);
});

test('fallback title is applied without falsely reporting generation success', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    sessions: [session],
    preferences: {
      titleSettings: {
        autoTitle: true,
        taskModel: 'llama3.2:3b',
      },
    },
    generatedTitle: {
      title: 'Explain why fallback text is',
      source: 'fallback',
    },
  });

  await page.goto('/c/title-session');
  const messageInput = page.getByRole('textbox', { name: 'Send a message' });
  await expect(messageInput).toBeVisible();

  await messageInput.fill('Explain why fallback text is used');
  await messageInput.press('Enter');

  await expect(
    page
      .getByTestId('sidebar-session-scroll-region')
      .getByText('Explain why fallback text is', { exact: true })
  ).toBeVisible();
  await expect(
    page.getByText('Could not generate a title; using the message preview', {
      exact: true,
    })
  ).toBeVisible();
  await expect(
    page.getByText('Chat title generated', { exact: true })
  ).toHaveCount(0);
  expect(mockApi.sessionUpdateRequests).toHaveLength(0);
});
