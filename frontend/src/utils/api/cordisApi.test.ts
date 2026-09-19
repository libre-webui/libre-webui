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
 * Cordis engine client: stream framing and error surfacing.
 *
 * The engine answers a chat turn with newline-delimited JSON, and a chunk can
 * be split across network reads. A parser that assumed one read per line would
 * lose or corrupt chunks only under load, so the framing is tested directly
 * against deliberately awkward splits.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

import type { CordisStreamChunk } from './cordisApi';

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: { getItem: () => 'test-token' },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      protocol: 'https:',
      hostname: 'chat.example.test',
      origin: 'https://chat.example.test',
    },
  },
});

// The shared HTTP client reads `import.meta.env` at module scope, which only
// exists under Vite. `sendMessage` deliberately uses `fetch` directly so a
// stream is not buffered, so the client is stubbed here rather than given a
// Node-side environment it is not written for.
const clientStub = `data:text/javascript,${encodeURIComponent(
  'export const api = globalThis.__cordisTestApi; export default api; export const isHttpError = () => false;'
)}`;
// The config module also reads `import.meta.env` at module scope, and the
// streaming path needs nothing from it but the base URL.
const configStub = `data:text/javascript,${encodeURIComponent(
  "export const API_BASE_URL = 'http://127.0.0.1:3001/api';"
)}`;
const STUBS: Record<string, string> = {
  './client': clientStub,
  '@/utils/api/client': clientStub,
  './config': configStub,
  '@/utils/config': configStub,
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    const stub = STUBS[specifier];
    return stub
      ? { url: stub, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

const httpRequests: Array<{ method: string; path: string; body?: unknown }> =
  [];
let httpResponse: unknown;
const request = async (method: string, path: string, body?: unknown) => {
  httpRequests.push({ method, path, ...(body === undefined ? {} : { body }) });
  return { data: httpResponse };
};
Object.assign(globalThis, {
  __cordisTestApi: {
    get: (path: string) => request('GET', path),
    patch: (path: string, body: unknown) => request('PATCH', path, body),
    post: (path: string, body: unknown) => request('POST', path, body),
  },
});

const { cordisApi } = await import('./cordisApi');

/** Build a response whose body arrives as exactly these reads. */
const streamed = (...reads: string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const read of reads) controller.enqueue(encoder.encode(read));
        controller.close();
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }
  );
};

/** Replace `fetch` for the duration of one test. */
const withFetch = async (
  implementation: typeof fetch,
  run: () => Promise<void>
): Promise<void> => {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
};

const TEXT_CHUNK: CordisStreamChunk = {
  type: 'text',
  text: 'Hello from the fake model.',
};
const DONE_CHUNK: CordisStreamChunk = { type: 'done', reason: 'stop' };
const BODY = `${JSON.stringify(TEXT_CHUNK)}\n${JSON.stringify(DONE_CHUNK)}\n`;

test('a chat turn yields every chunk in order', async () => {
  await withFetch(
    async () => streamed(BODY),
    async () => {
      const chunks = await cordisApi.sendMessage('session-1', 'hi');
      assert.deepEqual(chunks, [TEXT_CHUNK, DONE_CHUNK]);
    }
  );
});

test('chunks split across reads are reassembled', async () => {
  // Every boundary here lands mid-token, which is what a real network does.
  await withFetch(
    async () => streamed(BODY.slice(0, 5), BODY.slice(5, 30), BODY.slice(30)),
    async () => {
      const seen: CordisStreamChunk[] = [];
      const chunks = await cordisApi.sendMessage('session-1', 'hi', {
        onChunk: chunk => seen.push(chunk),
      });
      assert.deepEqual(chunks, [TEXT_CHUNK, DONE_CHUNK]);
      assert.deepEqual(seen, chunks, 'the callback sees the same sequence');
    }
  );
});

test('a final line without a trailing newline is still delivered', async () => {
  await withFetch(
    async () =>
      streamed(`${JSON.stringify(TEXT_CHUNK)}\n${JSON.stringify(DONE_CHUNK)}`),
    async () => {
      const chunks = await cordisApi.sendMessage('session-1', 'hi');
      assert.deepEqual(chunks, [TEXT_CHUNK, DONE_CHUNK]);
    }
  );
});

test('blank lines are ignored rather than parsed', async () => {
  await withFetch(
    async () =>
      streamed(
        `\n${JSON.stringify(TEXT_CHUNK)}\n\n\n${JSON.stringify(DONE_CHUNK)}\n`
      ),
    async () => {
      const chunks = await cordisApi.sendMessage('session-1', 'hi');
      assert.deepEqual(chunks, [TEXT_CHUNK, DONE_CHUNK]);
    }
  );
});

test('a rejected turn surfaces the engine error message', async () => {
  await withFetch(
    async () =>
      new Response(
        JSON.stringify({
          success: false,
          error:
            'cordis dsh engine: session "x" does not exist; create it first',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      ),
    async () => {
      await assert.rejects(
        cordisApi.sendMessage('x', 'hi'),
        /does not exist; create it first/
      );
    }
  );
});

test('a non-JSON failure still reports its status', async () => {
  await withFetch(
    async () => new Response('gateway exploded', { status: 502 }),
    async () => {
      await assert.rejects(cordisApi.sendMessage('x', 'hi'), /502/);
    }
  );
});

test('a response without a body is rejected', async () => {
  await withFetch(
    async () => new Response(null, { status: 204 }),
    async () => {
      await assert.rejects(
        cordisApi.sendMessage('x', 'hi'),
        /No response body reader/
      );
    }
  );
});

test('reasoning and multi-byte UTF-8 survive arbitrary byte boundaries', async () => {
  const reasoning: CordisStreamChunk = { type: 'reasoning', text: '考える 🧭' };
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(reasoning)}\r\n${JSON.stringify(DONE_CHUNK)}`
  );
  await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
            controller.close();
          },
        })
      ),
    async () => {
      assert.deepEqual(await cordisApi.sendMessage('session-1', 'hi'), [
        reasoning,
        DONE_CHUNK,
      ]);
    }
  );
});

test('a truncated or malformed stream rejects and releases its reader', async () => {
  for (const body of [
    JSON.stringify(TEXT_CHUNK),
    '{broken}\n',
    '{"type":"text"}\n',
  ]) {
    let released = false;
    await withFetch(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(body));
              if (body === JSON.stringify(TEXT_CHUNK)) controller.close();
            },
            cancel() {
              released = true;
            },
          })
        ),
      async () => {
        await assert.rejects(cordisApi.sendMessage('session-1', 'hi'));
        if (body !== JSON.stringify(TEXT_CHUNK)) assert.equal(released, true);
      }
    );
  }
});

test('done terminates an open stream and ignores duplicate terminal data', async () => {
  let released = false;
  await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(BODY + BODY));
          },
          cancel() {
            released = true;
          },
        })
      ),
    async () => {
      assert.deepEqual(await cordisApi.sendMessage('session-1', 'hi'), [
        TEXT_CHUNK,
        DONE_CHUNK,
      ]);
      assert.equal(released, true);
    }
  );
});

test('abort signal and credentials reach the transport', async () => {
  const controller = new AbortController();
  await withFetch(
    async (url, options) => {
      assert.match(String(url), /sessions\/session%2F1\/messages$/);
      assert.equal(options?.signal, controller.signal);
      assert.equal(
        (options?.headers as Record<string, string>).Authorization,
        'Bearer test-token'
      );
      controller.abort();
      return streamed(BODY);
    },
    async () => {
      await assert.rejects(
        cordisApi.sendMessage('session/1', 'hi', { signal: controller.signal }),
        { name: 'AbortError' }
      );
    }
  );
});

test('a streamed engine failure remains available to the transcript', async () => {
  const failure: CordisStreamChunk = {
    type: 'error',
    message: 'Provider unavailable',
    code: 'PROVIDER_ERROR',
  };
  await withFetch(
    async () =>
      streamed(`${JSON.stringify(failure)}\n${JSON.stringify(DONE_CHUNK)}\n`),
    async () => {
      const seen: CordisStreamChunk[] = [];
      await cordisApi.sendMessage('session-1', 'hi', {
        onChunk: chunk => seen.push(chunk),
      });
      assert.deepEqual(seen, [failure, DONE_CHUNK]);
    }
  );
});

test('settings and approval mutations stay scoped to their encoded session identifiers', async () => {
  httpRequests.length = 0;
  const session = {
    id: 'session/1',
    settings: { permissionMode: 'read-only' },
    messages: [],
  };
  httpResponse = { success: true, session };
  assert.deepEqual(
    await cordisApi.updateSettings('session/1', {
      permissionMode: 'read-only',
    }),
    session
  );
  httpResponse = { success: true };
  await cordisApi.decideApproval('session/1', 'approval/1', 'allowed-once');
  assert.deepEqual(httpRequests, [
    {
      method: 'PATCH',
      path: '/cordis/sessions/session%2F1/settings',
      body: { permissionMode: 'read-only' },
    },
    {
      method: 'POST',
      path: '/cordis/sessions/session%2F1/approvals/approval%2F1',
      body: { decision: 'allowed-once' },
    },
  ]);
});

test('provider catalogue retains qualified identifiers and its default model', async () => {
  httpResponse = {
    models: [
      {
        id: 'lwui:plugin:provider:actual-model',
        name: 'actual-model',
        providerType: 'plugin',
        providerId: 'provider',
      },
    ],
    defaultModel: 'lwui:plugin:provider:actual-model',
  };
  assert.deepEqual(await cordisApi.getModels(), httpResponse);
});

test('native approval events preserve the scope and decision while malformed requests fail', async () => {
  const chunks: CordisStreamChunk[] = [
    {
      type: 'approval-request',
      approval: { id: 'approval-1', sessionId: 'session-1', toolName: 'write' },
    },
    {
      type: 'approval-decision',
      approvalId: 'approval-1',
      outcome: 'rejected',
    },
    DONE_CHUNK,
  ];
  await withFetch(
    async () => streamed(chunks.map(chunk => JSON.stringify(chunk)).join('\n')),
    async () => {
      assert.deepEqual(await cordisApi.sendMessage('session-1', 'hi'), chunks);
    }
  );
  await withFetch(
    async () => streamed('{"type":"approval-request","approval":{"id":"x"}}\n'),
    async () => {
      await assert.rejects(
        cordisApi.sendMessage('session-1', 'hi'),
        /Invalid engine stream chunk/
      );
    }
  );
});
