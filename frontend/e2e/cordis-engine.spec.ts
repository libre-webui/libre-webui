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
 * Cordis engine page.
 *
 * The engine itself is a separate process tree that browser CI does not mount,
 * so `/api/cordis` is mocked here. That is the correct boundary to fake: the
 * page is a consumer of that contract, and faking it is what lets the suite
 * assert the two things a real engine could not make deterministic — the exact
 * chunk sequence, and the disabled-bridge state.
 *
 * The mock is registered after the shared API mock so it wins: Playwright
 * matches the most recently added route first.
 */

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';
import type {
  CordisMessage,
  CordisStreamChunk,
  CordisSession,
  CordisSessionSettings,
  CordisApproval,
} from '../src/utils/api/cordisApi';

const SESSION_ID = 'session-abc12345-1';
const CREATED_AT = 1_770_000_000_000;
const REPLY_TEXT = 'Archive the report and summarise it.';
const DEFAULT_MODEL = 'lwui:ollama:local-model';
const PLUGIN_MODEL = 'lwui:plugin:provider-a:code-model';

/** One chunk of the newline-delimited stream the backend produces. */
type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; callId: string; name: string }
  | { type: 'done'; reason: string };

/**
 * Serve the Cordis surface from memory.
 *
 * @param ready - whether the bridge reports itself available.
 * @param reason - the error the health route reports when it is not.
 */
async function mockCordisApi(
  page: Page,
  {
    ready = true,
    reason,
    accessEnabled = true,
    accessLocked = false,
  }: {
    ready?: boolean;
    reason?: string;
    accessEnabled?: boolean;
    accessLocked?: boolean;
  } = {}
) {
  let enabled = accessEnabled;
  const accessWrites: boolean[] = [];
  const cancellations: string[] = [];
  const settingsWrites: Array<{
    sessionId: string;
    settings: Partial<CordisSessionSettings>;
  }> = [];
  const approvalDecisions: Array<{ approvalId: string; decision: string }> = [];
  let settingsFailures = 0;
  const sessions: {
    id: string;
    createdAt: number;
    eventCount: number;
    settings: CordisSessionSettings;
    capabilities: CordisSession['capabilities'];
    approvals: CordisApproval[];
    active: boolean;
    workspacePath: string;
  }[] = [];
  const messages: Record<string, CordisMessage[]> = {};
  const chunks: StreamChunk[] = [
    { type: 'tool-call', callId: 'call-1', name: 'read' },
    { type: 'text', text: REPLY_TEXT },
    { type: 'done', reason: 'stop' },
  ];

  await page.route(/\/api\/cordis\/.*$/, async route => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api\/cordis/, '');
    const method = route.request().method();
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });

    if (path === '/access' && method === 'GET') {
      return json({
        success: true,
        enabled,
        lockedByEnv: accessLocked,
        ...(accessLocked ? { lockedBy: 'env' } : {}),
      });
    }
    if (path === '/access' && method === 'PUT') {
      const body = route.request().postDataJSON() as { enabled: boolean };
      accessWrites.push(body.enabled);
      if (accessLocked) {
        return json(
          {
            success: false,
            error:
              'The Cordis engine is pinned by LIBRE_CORDIS_ENABLED; unset the environment variable to manage it here.',
          },
          409
        );
      }
      enabled = body.enabled;
      return json({ success: true, enabled, lockedByEnv: false });
    }
    if (path === '/health') {
      return json(
        ready
          ? { success: true, enabled: true, ready: true, services: [] }
          : {
              success: false,
              enabled: true,
              ready: false,
              ...(reason ? { error: reason } : {}),
            },
        ready ? 200 : 503
      );
    }
    if (path === '/models')
      return json({
        success: true,
        defaultModel: DEFAULT_MODEL,
        models: [
          {
            id: DEFAULT_MODEL,
            name: 'local-model',
            providerType: 'ollama',
            providerName: 'Ollama',
          },
          {
            id: PLUGIN_MODEL,
            name: 'code-model',
            providerType: 'plugin',
            providerId: 'provider-a',
            providerName: 'Example Provider',
          },
          {
            id: 'persona:helper',
            name: 'Helper persona',
            providerType: 'persona',
          },
          { id: 'agent:codex', name: 'Host Codex', providerType: 'agent' },
        ],
      });
    if (path === '/tools') {
      return json({
        success: true,
        tools: [
          { name: 'read', description: 'Read a file from disk.' },
          { name: 'write', description: 'Write a file to disk.' },
        ],
      });
    }
    if (path === '/agents') {
      return json({ success: true, agents: [] });
    }
    if (path === '/sessions' && method === 'GET') {
      return json({ success: true, sessions });
    }
    if (path === '/sessions' && method === 'POST') {
      const requested = route
        .request()
        .postDataJSON() as Partial<CordisSessionSettings>;
      const session = {
        id:
          sessions.length === 0
            ? SESSION_ID
            : `${SESSION_ID}-${sessions.length + 1}`,
        createdAt: CREATED_AT,
        eventCount: 0,
        settings: {
          model: requested.model ?? DEFAULT_MODEL,
          permissionMode: requested.permissionMode ?? 'read-only',
        },
        capabilities: { permissions: true, approvals: true },
        approvals: [],
        active: false,
        workspacePath: '/workspace/cordis',
      };
      sessions.unshift(session);
      messages[session.id] = [];
      return json(
        { success: true, session: { ...session, messages: [] } },
        201
      );
    }
    const sessionId = path.split('/')[2];
    const session = sessions.find(item => item.id === sessionId);
    if (
      path === `/sessions/${sessionId}/settings` &&
      method === 'PATCH' &&
      session
    ) {
      const requested = route
        .request()
        .postDataJSON() as Partial<CordisSessionSettings>;
      settingsWrites.push({ sessionId, settings: requested });
      if (settingsFailures > 0) {
        settingsFailures -= 1;
        return json(
          { success: false, error: 'Settings could not be saved' },
          503
        );
      }
      session.settings = { ...session.settings, ...requested };
      return json({
        success: true,
        session: { ...session, messages: messages[sessionId] },
      });
    }
    if (
      path.startsWith(`/sessions/${sessionId}/approvals/`) &&
      method === 'POST' &&
      session
    ) {
      const approvalId = path.split('/').at(-1)!;
      const decision = route.request().postDataJSON().decision as string;
      approvalDecisions.push({ approvalId, decision });
      session.approvals = session.approvals.filter(
        item => item.id !== approvalId
      );
      return json({ success: true });
    }
    if (path === `/sessions/${sessionId}/cancel` && method === 'POST') {
      cancellations.push(sessionId);
      if (session) {
        session.active = false;
        session.approvals = [];
      }
      return json({ success: true });
    }
    if (path === `/sessions/${sessionId}` && method === 'GET' && session) {
      return json({
        success: true,
        session: {
          ...session,
          eventCount: messages[sessionId].length,
          messages: messages[sessionId],
        },
      });
    }
    if (
      path === `/sessions/${sessionId}/messages` &&
      method === 'POST' &&
      session
    ) {
      const request = route.request().postDataJSON() as { text: string };
      messages[sessionId].push({
        id: 'm-user',
        role: 'user',
        text: request.text,
      });
      messages[sessionId].push({
        id: 'm-assistant',
        role: 'assistant',
        text: REPLY_TEXT,
      });
      // The backend answers with NDJSON; one line per chunk.
      return route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: `${chunks.map(chunk => JSON.stringify(chunk)).join('\n')}\n`,
      });
    }
    return json({ success: false, error: `unmocked ${method} ${path}` }, 404);
  });
  return {
    accessWrites,
    cancellations,
    settingsWrites,
    approvalDecisions,
    failNextSettings: () => {
      settingsFailures += 1;
    },
    setApprovals: (sessionId: string, approvals: CordisApproval[]) => {
      const session = sessions.find(item => item.id === sessionId);
      if (session) session.approvals = approvals;
      if (session) session.active = approvals.length > 0;
    },
    snapshotSession: (sessionId: string) => {
      const session = sessions.find(item => item.id === sessionId);
      if (!session) throw new Error('Missing fixture session');
      return structuredClone({ ...session, messages: messages[sessionId] });
    },
    isEnabled: () => enabled,
    setMessages: (sessionId: string, next: CordisMessage[]) => {
      messages[sessionId] = next;
    },
  };
}

/** Keep the response open until the test publishes actual NDJSON bytes. */
async function mockLiveStream(page: Page) {
  await page.addInitScript(() => {
    const state = {
      sessionId: '',
      aborted: false,
      push: (_chunks: unknown[]) => {},
    };
    Object.assign(window, { cordisTestStream: state });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = String(input);
      const match = url.match(/\/cordis\/sessions\/([^/]+)\/messages$/);
      if (!match) return originalFetch(input, init);
      state.sessionId = decodeURIComponent(match[1]);
      const signal = init?.signal;
      let onAbort: () => void;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            state.push = chunks =>
              controller.enqueue(
                new TextEncoder().encode(
                  chunks.map(chunk => JSON.stringify(chunk)).join('\n') + '\n'
                )
              );
            onAbort = () => {
              state.aborted = true;
              controller.error(new DOMException('Aborted', 'AbortError'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            if (signal?.aborted) onAbort();
          },
          cancel() {
            signal?.removeEventListener('abort', onAbort);
          },
        }),
        { headers: { 'Content-Type': 'application/x-ndjson' } }
      );
    };
  });
}

async function pushLiveChunks(page: Page, chunks: CordisStreamChunk[]) {
  await page.evaluate(next => {
    (
      window as unknown as {
        cordisTestStream: { push(chunks: unknown[]): void };
      }
    ).cordisTestStream.push(next);
  }, chunks);
}

test('an operator can create a session and stream a turn', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: false,
      hasUsers: true,
      userCount: 1,
      version: '0.36.0-e2e',
      turnstile: { enabled: false },
      cordisEnabled: true,
    },
  } as never);
  await mockCordisApi(page);
  await page.goto('/cordis');

  // The engine registers tools, and the page lists them.
  const tools = page.getByTestId('cordis-tool-list');
  await page.getByTestId('cordis-tools-disclosure').locator('summary').click();
  await expect(tools.getByText('read', { exact: true })).toBeVisible();
  await expect(tools.getByText('write', { exact: true })).toBeVisible();

  await expect(
    page.getByText('No sessions yet. Create one to start.')
  ).toBeVisible();

  await page.getByTestId('cordis-create-session').click();

  const list = page.getByTestId('cordis-session-list');
  await expect(
    list.getByRole('button', { name: new RegExp(SESSION_ID) })
  ).toBeVisible();

  const composer = page.getByTestId('cordis-composer');
  await composer.fill('Summarise the report');
  await page.getByTestId('cordis-send').click();

  // Both the user's turn and the streamed assistant reply land in the
  // transcript, and the turn is durable because the page re-reads it.
  const transcript = page.getByTestId('cordis-transcript');
  await expect(transcript.getByText('Summarise the report')).toBeVisible();
  // `toHaveCount` rather than `toBeVisible`: the reply must appear exactly
  // once. The streamed buffer and the durable transcript can both hold it, and
  // a visibility assertion passes even when both are rendered.
  await expect(transcript.getByText(REPLY_TEXT)).toHaveCount(1);
  await expect(page.getByTestId('cordis-streaming')).toHaveCount(0);
});

test('a disabled bridge explains itself instead of looking empty', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: false,
      hasUsers: true,
      userCount: 1,
      version: '0.36.0-e2e',
      turnstile: { enabled: false },
      cordisEnabled: true,
    },
  } as never);
  await mockCordisApi(page, {
    ready: false,
    reason:
      'cordis host: the composition did not provide required service(s): tools',
  });
  await page.goto('/cordis');

  const notice = page.getByTestId('cordis-unavailable');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('did not provide required service');

  // Nothing should offer to start work against an engine that cannot serve it.
  await expect(page.getByTestId('cordis-create-session')).toBeDisabled();
  await expect(page.getByTestId('cordis-model-select')).toBeDisabled();
  await expect(page.getByTestId('cordis-permission-select')).toBeDisabled();
  await expect(page.getByTestId('cordis-composer')).toBeDisabled();
});

test('sessions are reachable from the sidebar', async ({ page }) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: false,
      hasUsers: true,
      userCount: 1,
      version: '0.36.0-e2e',
      turnstile: { enabled: false },
      cordisEnabled: true,
    },
  } as never);
  await mockCordisApi(page);
  await page.goto('/');

  await page
    .getByRole('navigation', { name: 'Explore' })
    .getByRole('link', { name: 'Cordis Engine' })
    .click();

  await expect(page.getByTestId('cordis-page')).toBeVisible();
  await expect(page).toHaveURL(/\/cordis$/);
});

test('an administrator enables the engine from the settings panel', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    // The engine starts opted out, as it does in a fresh deployment.
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.36.0-e2e',
      turnstile: { enabled: false },
      cordisEnabled: false,
    },
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
  } as never);
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });
  // The destination is an administrator opt-in, so an opted-out deployment
  // does not advertise a page it cannot serve.
  const cordis = await mockCordisApi(page, { accessEnabled: false });
  await page.goto('/');
  const navigation = page.getByRole('navigation', { name: 'Explore' });
  await expect(
    navigation.getByRole('link', { name: 'Cordis Engine' })
  ).toHaveCount(0);

  await page.goto('/users');
  await page
    .getByRole('tab', { name: 'Access & policies', exact: true })
    .click();
  const card = page.getByTestId('cordis-access-settings');
  await expect(card).toBeVisible();
  // The native input is visually hidden behind the switch the label draws, so
  // the label — the element a user actually clicks — is the click target.
  const toggle = card.getByRole('checkbox');
  await expect(toggle).toBeEnabled();
  await card.locator('label').click();

  await expect
    .poll(() => cordis.accessWrites.length, {
      message: 'the panel must persist the decision',
    })
    .toBeGreaterThan(0);
  expect(cordis.accessWrites.at(-1)).toBe(true);
});

test('a pinned engine explains the lock instead of failing silently', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.36.0-e2e',
      turnstile: { enabled: false },
      cordisEnabled: true,
    },
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
  } as never);
  await mockCordisApi(page, { accessEnabled: true, accessLocked: true });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/users');
  await page
    .getByRole('tab', { name: 'Access & policies', exact: true })
    .click();
  await expect(page.getByTestId('cordis-access-locked')).toBeVisible();
  await expect(page.getByTestId('cordis-access-locked')).toContainText(
    'LIBRE_CORDIS_ENABLED'
  );
});

test('the tab strip shows the Cordis Engine tab for its route', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 1,
      version: '0.36.0-e2e',
      turnstile: { enabled: false },
      cordisEnabled: true,
    },
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
  } as never);
  await mockCordisApi(page);
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });

  // Opening the destination from the tab menu must label the tab, not leave the
  // strip showing whichever tab was active before.
  await page.goto('/');
  await page.getByTestId('app-tab-new').click();
  await page
    .getByTestId('app-tab-new-menu')
    .getByRole('menuitem', { name: 'Cordis Engine' })
    .click();

  await expect(page).toHaveURL(/\/cordis$/);
  await expect(page.getByTestId('cordis-page')).toBeVisible();

  const tabStrip = page.getByTestId('app-tab-bar');
  await expect(
    tabStrip.getByRole('tab', { name: /Cordis Engine/ })
  ).toHaveAttribute('aria-selected', 'true');
  // The Home tab must not claim to be the Cordis page, which is what happened
  // before the route was registered with the tab shell.
  await expect(tabStrip.getByRole('tab', { name: /Home/ })).toHaveAttribute(
    'aria-selected',
    'false'
  );
});

test('an active turn locks session changes and Stop cancels its own session', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await mockLiveStream(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  await page.getByTestId('cordis-create-session').click();
  const firstSession = page
    .getByTestId('cordis-session-list')
    .getByRole('button', { name: SESSION_ID, exact: true });
  await firstSession.click();
  await page.getByTestId('cordis-composer').fill('A long tool run');
  await page.getByTestId('cordis-send').click();
  await expect(page.getByTestId('cordis-stop')).toBeVisible();
  await expect(page.getByTestId('cordis-create-session')).toBeDisabled();
  for (const button of await page
    .getByTestId('cordis-session-list')
    .getByRole('button')
    .all()) {
    await expect(button).toBeDisabled();
  }
  await pushLiveChunks(page, [{ type: 'text', text: 'Still working in A' }]);
  await expect(page.getByTestId('cordis-streaming')).toContainText(
    'Still working in A'
  );
  await page.getByTestId('cordis-stop').click();
  await expect.poll(() => cordis.cancellations).toEqual([SESSION_ID]);
  await expect(page.getByTestId('cordis-stop')).toHaveCount(0);
  await expect(page.getByTestId('cordis-create-session')).toBeEnabled();
  await page
    .getByTestId('cordis-session-list')
    .getByRole('button', { name: new RegExp(`${SESSION_ID}-2`) })
    .click();
  await expect(page.getByTestId('cordis-transcript')).not.toContainText(
    'Still working in A'
  );
});

test('leaving the engine page cancels its running turn', async ({ page }) => {
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await mockLiveStream(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  await page.getByTestId('cordis-composer').fill('Do not keep tools running');
  await page.getByTestId('cordis-send').click();
  await expect(page.getByTestId('cordis-stop')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Explore' })
    .getByRole('link', { name: 'Personas', exact: true })
    .click();
  await expect.poll(() => cordis.cancellations).toEqual([SESSION_ID]);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { cordisTestStream: { aborted: boolean } })
            .cordisTestStream.aborted
      )
    )
    .toBe(true);
});

test('reasoning streams separately and repeated answers replace the live view once', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await mockLiveStream(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  const reasoning = 'Check the report before answering.';
  for (let turn = 1; turn <= 2; turn += 1) {
    await page.getByTestId('cordis-composer').fill('Repeat the answer');
    await page.getByTestId('cordis-send').click();
    await expect(page.getByTestId('cordis-stop')).toBeVisible();
    await pushLiveChunks(page, [{ type: 'reasoning', text: reasoning }]);
    const streaming = page.getByTestId('cordis-streaming');
    await streaming.getByText('Thinking', { exact: true }).click();
    await expect(streaming).toContainText(reasoning);
    await pushLiveChunks(page, [{ type: 'text', text: REPLY_TEXT }]);
    await expect(streaming).toContainText(REPLY_TEXT);
    cordis.setMessages(
      SESSION_ID,
      Array.from({ length: turn }, (_, index) => ({
        id: `answer-${index}`,
        role: 'assistant',
        text: REPLY_TEXT,
        reasoning,
      }))
    );
    // A replay after done must not append another copy of the answer.
    await pushLiveChunks(page, [
      { type: 'done', reason: 'stop' },
      { type: 'text', text: REPLY_TEXT },
    ]);
    await expect(streaming).toHaveCount(0);
    await expect(
      page
        .getByTestId('cordis-transcript')
        .getByText(REPLY_TEXT, { exact: true })
    ).toHaveCount(turn);
    await expect(page.getByTestId('cordis-reasoning')).toHaveCount(turn);
  }
});

test('engine stream failures remain visible until selecting another session', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockCordisApi(page);
  await mockLiveStream(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  await page.getByTestId('cordis-composer').fill('Try the provider');
  await page.getByTestId('cordis-send').click();
  await expect(page.getByTestId('cordis-stop')).toBeVisible();
  await pushLiveChunks(page, [
    { type: 'error', message: 'Provider route has no available model' },
    { type: 'done', reason: 'error' },
  ]);
  await expect(page.getByTestId('cordis-turn-error')).toContainText(
    'Provider route has no available model'
  );
  await expect(page.getByTestId('cordis-stop')).toHaveCount(0);
  await page.getByTestId('cordis-create-session').click();
  await expect(page.getByTestId('cordis-turn-error')).toHaveCount(0);
});

test('a regular account cannot open the engine route directly', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo: {
      requiresAuth: true,
      hasUsers: true,
      userCount: 2,
      version: '0.36.0-e2e',
      cordisEnabled: true,
    },
    authUsers: [
      {
        id: 'regular-user',
        username: 'regular',
        email: 'regular@example.test',
        role: 'user',
        status: 'active',
        token: 'regular-token',
      },
    ],
  });
  await mockCordisApi(page);
  await page.addInitScript(() =>
    localStorage.setItem('auth-token', 'regular-token')
  );
  await page.goto('/cordis');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('cordis-page')).toHaveCount(0);
  await expect(
    page
      .getByRole('navigation', { name: 'Explore' })
      .getByRole('link', { name: 'Cordis Engine' })
  ).toHaveCount(0);
});

test('the transcript renders safe Markdown and copyable code while context stays collapsed', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) =>
          Object.assign(window, { cordisCopiedText: text }),
      },
    });
  });
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  const code = 'const answer = 42;';
  const reply = `## A useful answer\n\n- First step\n- Second step\n\n\`\`\`typescript\n${code}\n\`\`\`\n\n<img src=x onerror="window.cordisInjected=true">`;
  cordis.setMessages(SESSION_ID, [
    {
      id: 'system',
      role: 'system',
      source: 'system',
      text: 'Private system context',
    },
    {
      id: 'runtime',
      role: 'user',
      source: 'context',
      text: 'Injected runtime directory details',
    },
    { id: 'user', role: 'user', source: 'user', text: 'Explain the answer' },
    {
      id: 'answer',
      role: 'assistant',
      source: 'model',
      text: reply,
      reasoning: 'Check the arithmetic.',
    },
  ]);
  await page.reload();
  const transcript = page.getByTestId('cordis-transcript');
  await expect(
    transcript.getByRole('heading', { name: 'A useful answer' })
  ).toBeVisible();
  await expect(transcript.getByRole('listitem')).toHaveCount(2);
  await expect(transcript.locator('[data-role="user"]')).toHaveCount(1);
  await expect(
    page.getByText('Private system context', { exact: true })
  ).not.toBeVisible();
  await expect(
    page.getByText('Injected runtime directory details', { exact: true })
  ).not.toBeVisible();
  await page.getByTestId('cordis-context').locator('summary').click();
  await expect(
    page.getByText('Injected runtime directory details', { exact: true })
  ).toBeVisible();
  const block = transcript.getByTestId('code-block');
  await expect(block.locator('code')).toContainText(code);
  await expect(block.locator('code span').first()).toBeVisible();
  await block
    .getByRole('button', { name: 'Copy code: typescript', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { cordisCopiedText?: string }).cordisCopiedText
      )
    )
    .toBe(code);
  const answer = transcript.locator('[data-role="assistant"]');
  await answer
    .getByRole('button', { name: 'Copy message', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { cordisCopiedText?: string }).cordisCopiedText
      )
    )
    .toBe(reply);
  expect(
    await page.evaluate(() =>
      Boolean(
        (window as unknown as { cordisInjected?: boolean }).cordisInjected
      )
    )
  ).toBe(false);
});

test('models and permissions persist per session and failed writes preserve the saved setting', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await page.goto('/cordis');
  const model = page.getByTestId('cordis-model-select');
  const permission = page.getByTestId('cordis-permission-select');
  await expect(model.locator('option')).toHaveText([
    'local-model · Ollama',
    'code-model · Example Provider',
  ]);
  await expect(permission).toHaveValue('read-only');
  await model.selectOption(PLUGIN_MODEL);
  await page.getByTestId('cordis-create-session').click();
  await expect(model).toHaveValue(PLUGIN_MODEL);
  await permission.selectOption('workspace-write');
  await expect(permission).toHaveValue('workspace-write');
  expect(cordis.settingsWrites).toEqual([
    { sessionId: SESSION_ID, settings: { permissionMode: 'workspace-write' } },
  ]);
  cordis.failNextSettings();
  await permission.selectOption('read-only');
  await expect(page.getByRole('alert')).toContainText(
    'Settings could not be saved'
  );
  await expect(permission).toHaveValue('workspace-write');
  await permission.selectOption('read-only');
  await expect(permission).toHaveValue('read-only');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await permission.selectOption('workspace-write');
  await expect(permission).toHaveValue('workspace-write');
  await page.getByTestId('cordis-create-session').click();
  await expect(permission).toHaveValue('read-only');
  await page.reload();
  await page
    .getByTestId('cordis-session-list')
    .getByRole('button', { name: SESSION_ID, exact: true })
    .click();
  await expect(permission).toHaveValue('workspace-write');
  await expect(model).toHaveValue(PLUGIN_MODEL);
});

for (const decision of ['allowed-once', 'rejected'] as const) {
  test(`native approval ${decision} and tool output remain usable during streaming and after reload`, async ({
    page,
  }) => {
    await mockLibreWebUiApi(page);
    const cordis = await mockCordisApi(page);
    await mockLiveStream(page);
    await page.goto('/cordis');
    await page.getByTestId('cordis-create-session').click();
    await page.getByTestId('cordis-composer').fill('Run the approved tool');
    await page.getByTestId('cordis-send').click();
    await expect(page.getByTestId('cordis-stop')).toBeVisible();
    const approval = {
      id: 'approval-1',
      sessionId: SESSION_ID,
      callId: 'call-1',
      toolName: 'run_command',
      reason: 'Run the workspace tests',
    };
    await pushLiveChunks(page, [
      {
        type: 'tool-call',
        callId: 'call-1',
        name: 'run_command',
        arguments: '{"command":"npm test"}',
      },
      { type: 'approval-request', approval },
    ]);
    await expect(page.getByTestId('cordis-tool-activity')).toContainText(
      'Waiting for approval'
    );
    await expect(page.getByTestId('cordis-approval')).toContainText(
      'Run the workspace tests'
    );
    await page
      .getByTestId('cordis-approval')
      .getByRole('button', {
        name: decision === 'allowed-once' ? 'Allow once' : 'Deny',
        exact: true,
      })
      .click();
    await expect
      .poll(() => cordis.approvalDecisions)
      .toEqual([{ approvalId: approval.id, decision }]);
    await expect(page.getByTestId('cordis-approval')).toHaveCount(0);
    const output =
      decision === 'allowed-once'
        ? 'All tests passed'
        : 'The command was denied';
    cordis.setMessages(SESSION_ID, [
      {
        id: 'call',
        role: 'assistant',
        source: 'model',
        text: '',
        toolCalls: [
          {
            callId: 'call-1',
            name: 'run_command',
            arguments: '{"command":"npm test"}',
          },
        ],
      },
      {
        id: 'result',
        role: 'tool',
        source: 'tool',
        text: output,
        toolResults: [
          {
            callId: 'call-1',
            name: 'run_command',
            output,
            isError: decision === 'rejected',
          },
        ],
      },
      { id: 'answer', role: 'assistant', text: 'The request is complete.' },
    ]);
    await pushLiveChunks(page, [
      {
        type: 'tool-result',
        callId: 'call-1',
        name: 'run_command',
        output,
        isError: decision === 'rejected',
      },
      { type: 'done', reason: 'stop' },
    ]);
    await expect(page.getByTestId('cordis-stop')).toHaveCount(0);
    await page.reload();
    const card = page.getByTestId('cordis-tool-activity');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText(
      decision === 'allowed-once' ? 'Done' : 'Failed'
    );
    await card.locator('summary').click();
    await expect(card).toContainText('npm test');
    await expect(card.getByText(output, { exact: true })).toBeVisible();
  });
}

test('startup errors offer a working retry', async ({ page }) => {
  await mockLibreWebUiApi(page);
  await mockCordisApi(page);
  let attempts = 0;
  await page.route('**/api/cordis/models', async route => {
    if (++attempts === 1)
      return route.fulfill({
        status: 503,
        json: { error: 'Provider temporarily unavailable' },
      });
    return route.fallback();
  });
  await page.goto('/cordis');
  await expect(page.getByTestId('cordis-unavailable')).toBeVisible();
  await page
    .getByTestId('cordis-unavailable')
    .getByRole('button', { name: 'Retry', exact: true })
    .click();
  await expect(page.getByTestId('cordis-create-session')).toBeEnabled();
  await expect(page.getByTestId('cordis-unavailable')).toHaveCount(0);
});

test('a restored active session keeps permissions locked and exposes pending native approval', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  cordis.setMessages(SESSION_ID, [
    {
      id: 'old-call',
      role: 'assistant',
      text: '',
      toolCalls: [{ callId: 'old-call', name: 'read', arguments: '{}' }],
    },
    { id: 'current-user', role: 'user', text: 'Edit the current file.' },
    {
      id: 'current-call',
      role: 'assistant',
      text: '',
      toolCalls: [{ callId: 'current-call', name: 'write', arguments: '{}' }],
    },
  ]);
  cordis.setApprovals(SESSION_ID, [
    {
      id: 'restored-approval',
      sessionId: SESSION_ID,
      toolName: 'write',
      callId: 'current-call',
      reason: 'Edit a workspace file',
    },
  ]);
  await page.reload();
  await expect(page.getByTestId('cordis-workspace-scope')).toContainText(
    '/workspace/cordis'
  );
  await expect(page.getByTestId('cordis-model-select')).toBeDisabled();
  await expect(page.getByTestId('cordis-permission-select')).toBeDisabled();
  await expect(page.getByTestId('cordis-approval')).toContainText(
    'Edit a workspace file'
  );
  await expect(
    page.locator(
      '[data-testid="cordis-tool-activity"][data-call-id="old-call"]'
    )
  ).toContainText('Cancelled');
  await expect(
    page.locator(
      '[data-testid="cordis-tool-activity"][data-call-id="current-call"]'
    )
  ).toContainText('Waiting for approval');
  await page
    .getByTestId('cordis-approval')
    .getByRole('button', { name: 'Allow once', exact: true })
    .click();
  await expect
    .poll(() => cordis.approvalDecisions)
    .toEqual([{ approvalId: 'restored-approval', decision: 'allowed-once' }]);
  await expect(
    page.locator(
      '[data-testid="cordis-tool-activity"][data-call-id="current-call"]'
    )
  ).toContainText('Running');
  await page.getByTestId('cordis-stop').click();
  await expect.poll(() => cordis.cancellations).toEqual([SESSION_ID]);
  await expect(page.getByTestId('cordis-stop')).toHaveCount(0);
  await expect(page.getByTestId('cordis-permission-select')).toBeEnabled();
});

test('the composer stays visible with a long transcript on a narrow Arabic screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'ar'));
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  cordis.setMessages(
    SESSION_ID,
    Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: 'assistant',
      text: 'Long transcript content. '.repeat(20),
    }))
  );
  await page.reload();
  await expect(
    page.getByTestId('cordis-permission-select')
  ).toHaveAccessibleName('الصلاحيات');
  await expect(page.getByTestId('cordis-composer')).toBeVisible();
  const composer = await page.getByTestId('cordis-composer').boundingBox();
  expect(composer.y + composer.height).toBeLessThanOrEqual(844);
  const viewport = page.getByTestId('cordis-transcript-scroll');
  expect(
    await viewport.evaluate(node => node.scrollHeight > node.clientHeight)
  ).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true);
});

test('reused provider tool IDs keep each turn paired with its own result', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  cordis.setMessages(SESSION_ID, [
    {
      id: 'first-call',
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          callId: 'readcall_0',
          name: 'read',
          arguments: '{"path":"first.txt"}',
        },
      ],
    },
    {
      id: 'first-result',
      role: 'tool',
      text: '',
      toolResults: [
        { callId: 'readcall_0', output: 'First file contents', isError: false },
      ],
    },
    { id: 'next-user', role: 'user', text: 'Now read the next file.' },
    {
      id: 'second-call',
      role: 'assistant',
      text: '',
      toolCalls: [
        {
          callId: 'readcall_0',
          name: 'read',
          arguments: '{"path":"second.txt"}',
        },
      ],
    },
    {
      id: 'second-result',
      role: 'tool',
      text: '',
      toolResults: [
        {
          callId: 'readcall_0',
          output: 'Second file contents',
          isError: false,
        },
      ],
    },
  ]);
  await page.reload();
  const cards = page.getByTestId('cordis-tool-activity');
  await expect(cards).toHaveCount(2);
  await cards.nth(0).locator('summary').click();
  await cards.nth(1).locator('summary').click();
  await expect(cards.nth(0)).toContainText('first.txt');
  await expect(cards.nth(0)).toContainText('First file contents');
  await expect(cards.nth(0)).not.toContainText('Second file contents');
  await expect(cards.nth(1)).toContainText('second.txt');
  await expect(cards.nth(1)).toContainText('Second file contents');
});

test('live tool rounds with the same provider ID retain separate output cards', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockCordisApi(page);
  await mockLiveStream(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  await page.getByTestId('cordis-composer').fill('Read two files');
  await page.getByTestId('cordis-send').click();
  await expect(page.getByTestId('cordis-stop')).toBeVisible();
  await pushLiveChunks(page, [
    {
      type: 'tool-call',
      callId: 'readcall_0',
      name: 'read',
      arguments: '{"path":"first.txt"}',
    },
    {
      type: 'tool-result',
      callId: 'readcall_0',
      name: 'read',
      output: 'First live result',
      isError: false,
    },
  ]);
  const cards = page.getByTestId('cordis-tool-activity');
  await expect(cards).toHaveCount(1);
  await cards.nth(0).locator('summary').click();
  await expect(
    cards.nth(0).getByText('First live result', { exact: true })
  ).toBeVisible();
  await pushLiveChunks(page, [
    {
      type: 'tool-call',
      callId: 'readcall_0',
      name: 'read',
      arguments: '{"path":"second.txt"}',
    },
  ]);
  await expect(cards).toHaveCount(2);
  await cards.nth(1).locator('summary').click();
  await expect(cards.nth(1)).toContainText('second.txt');
  await expect(cards.nth(1)).toContainText('Running');
  await expect(cards.nth(1)).not.toContainText('First live result');
  await pushLiveChunks(page, [
    {
      type: 'tool-result',
      callId: 'readcall_0',
      name: 'read',
      output: 'Second live result',
      isError: false,
    },
  ]);
  await expect(cards.nth(0)).toContainText('First live result');
  await expect(cards.nth(0)).not.toContainText('Second live result');
  await expect(cards.nth(1)).toContainText('Second live result');
  await expect(cards.nth(1)).toContainText('Done');
  await expect(cards.nth(0)).toHaveAttribute('data-call-id', 'readcall_0');
  await expect(cards.nth(1)).toHaveAttribute('data-call-id', 'readcall_0');
  await page.getByTestId('cordis-stop').click();
});

test('slow approval polling is serialized and cannot resurrect a decided request', async ({
  page,
}) => {
  await page.clock.install();
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  cordis.setApprovals(SESSION_ID, [
    {
      id: 'pending-old',
      sessionId: SESSION_ID,
      toolName: 'write',
      reason: 'Original approval',
    },
  ]);
  await page.reload();
  await expect(page.getByTestId('cordis-approval')).toContainText(
    'Original approval'
  );
  const snapshot = cordis.snapshotSession(SESSION_ID);
  let reads = 0;
  let release = () => {};
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.route(`**/api/cordis/sessions/${SESSION_ID}`, async route => {
    reads += 1;
    if (reads !== 1) return route.fallback();
    await blocked;
    return route.fulfill({ json: { success: true, session: snapshot } });
  });
  try {
    await page.clock.runFor(2000);
    await expect.poll(() => reads).toBe(1);
    await page.clock.runFor(6000);
    expect(reads).toBe(1);
    await page
      .getByTestId('cordis-approval')
      .getByRole('button', { name: 'Allow once', exact: true })
      .click();
    await expect(page.getByTestId('cordis-approval')).toHaveCount(0);
    const response = page.waitForResponse(response =>
      response.url().endsWith(`/cordis/sessions/${SESSION_ID}`)
    );
    release();
    await (await response).finished();
    await page.clock.runFor(16);
    await expect(page.getByTestId('cordis-approval')).toHaveCount(0);
    await page.getByTestId('cordis-stop').click();
    await expect(page.getByTestId('cordis-stop')).toHaveCount(0);
  } finally {
    release();
  }
});

test('an approval error resync cannot erase a newer streamed request', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const cordis = await mockCordisApi(page);
  await mockLiveStream(page);
  await page.goto('/cordis');
  await page.getByTestId('cordis-create-session').click();
  await page
    .getByTestId('cordis-composer')
    .fill('Perform two approved actions');
  await page.getByTestId('cordis-send').click();
  await expect(page.getByTestId('cordis-stop')).toBeVisible();
  const first = {
    id: 'first-approval',
    sessionId: SESSION_ID,
    toolName: 'write',
    reason: 'First approval',
  };
  cordis.setApprovals(SESSION_ID, [first]);
  await pushLiveChunks(page, [{ type: 'approval-request', approval: first }]);
  const snapshot = cordis.snapshotSession(SESSION_ID);
  snapshot.approvals = [];
  let resyncStarted = false;
  let release = () => {};
  const blocked = new Promise<void>(resolve => {
    release = resolve;
  });
  await page.route(
    `**/api/cordis/sessions/${SESSION_ID}/approvals/first-approval`,
    route =>
      route.fulfill({
        status: 503,
        json: { error: 'Decision response was lost' },
      })
  );
  await page.route(`**/api/cordis/sessions/${SESSION_ID}`, async route => {
    if (resyncStarted) return route.fallback();
    resyncStarted = true;
    await blocked;
    return route.fulfill({ json: { success: true, session: snapshot } });
  });
  try {
    await page
      .getByTestId('cordis-approval')
      .getByRole('button', { name: 'Allow once', exact: true })
      .click();
    await expect.poll(() => resyncStarted).toBe(true);
    const second = {
      id: 'second-approval',
      sessionId: SESSION_ID,
      toolName: 'write',
      reason: 'Second approval',
    };
    cordis.setApprovals(SESSION_ID, [second]);
    await pushLiveChunks(page, [
      {
        type: 'approval-decision',
        approvalId: first.id,
        outcome: 'allowed-once',
      },
      { type: 'approval-request', approval: second },
    ]);
    await expect(page.getByTestId('cordis-approval')).toContainText(
      'Second approval'
    );
    release();
    const deny = page
      .getByTestId('cordis-approval')
      .getByRole('button', { name: 'Deny', exact: true });
    await expect(deny).toBeEnabled();
    await expect(page.getByTestId('cordis-approval')).toContainText(
      'Second approval'
    );
    await deny.click();
    await expect
      .poll(() => cordis.approvalDecisions)
      .toEqual([{ approvalId: second.id, decision: 'rejected' }]);
    await page.getByTestId('cordis-stop').click();
  } finally {
    release();
  }
});
