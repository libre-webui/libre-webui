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
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import test, { afterEach, beforeEach } from 'node:test';

type TicketResponse = { data: { success: boolean; data?: { ticket: string } } };
const requests: { path: string; data: unknown }[] = [];
const ticketResponse = (ticket: string): TicketResponse => ({
  data: { success: true, data: { ticket } },
});
let requestTicket: () => Promise<TicketResponse> = async () =>
  ticketResponse(`ticket-${requests.length}`);
const api = {
  post: (path: string, data: unknown) => {
    requests.push({ path, data });
    return requestTicket();
  },
};
Object.defineProperty(globalThis, '__websocketTestApi', { value: api });
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    location: {
      protocol: 'http:',
      host: 'localhost:5173',
      hostname: 'localhost',
    },
    localStorage: { getItem: () => 'silent' },
  },
});
const mockModule = `data:text/javascript,${encodeURIComponent(
  'export const api = globalThis.__websocketTestApi;'
)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === '@/utils/api/client'
      ? { url: mockModule, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

class ControlledWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: ControlledWebSocket[] = [];
  readyState = ControlledWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor(readonly url: string) {
    ControlledWebSocket.instances.push(this);
  }
  open() {
    this.readyState = ControlledWebSocket.OPEN;
    this.onopen?.();
  }
  close() {
    this.readyState = ControlledWebSocket.CLOSED;
    this.onclose?.();
  }
  failThenClose() {
    this.readyState = ControlledWebSocket.CLOSING;
    this.onerror?.(new Event('error'));
    this.close();
  }
  message(type: string, data: unknown) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) });
  }
}
Object.defineProperty(globalThis, 'WebSocket', {
  configurable: true,
  value: ControlledWebSocket,
});

const { WebSocketService } = await import('./websocket');
const services: InstanceType<typeof WebSocketService>[] = [];
const createService = () => {
  const service = new WebSocketService();
  services.push(service);
  return service;
};
const drain = async () => {
  for (let turn = 0; turn < 6; turn += 1) await setImmediate();
};

beforeEach(() => {
  requests.length = 0;
  ControlledWebSocket.instances = [];
  requestTicket = async () => ticketResponse(`ticket-${requests.length}`);
});
afterEach(() => {
  for (const service of services.splice(0)) service.disconnect();
});

test('transient startup failures recover beyond five retries with a capped backoff', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createService();
  requestTicket = async () => {
    throw new Error('ECONNREFUSED');
  };
  await assert.rejects(service.connect(), /ECONNREFUSED/);
  let expectedRequests = 1;
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    context.mock.timers.tick(delay - 1);
    await drain();
    assert.equal(requests.length, expectedRequests);
    context.mock.timers.tick(1);
    await drain();
    assert.equal(requests.length, ++expectedRequests);
  }
  assert.equal(ControlledWebSocket.instances.length, 0);
  requestTicket = async () => ticketResponse('recovered-ticket');
  context.mock.timers.tick(30000);
  await drain();
  const socket = ControlledWebSocket.instances[0];
  assert.equal(
    new URL(socket.url).searchParams.get('ticket'),
    'recovered-ticket'
  );
  socket.open();
  await drain();
  assert.equal(service.isConnected, true);
  assert.ok(
    requests.every(request => request.path === '/auth/websocket-ticket')
  );
  assert.ok(
    requests.every(
      request => JSON.stringify(request.data) === '{"audience":"chat"}'
    )
  );

  // A successful connection resets the retry delay for a later disconnect.
  const beforeClose = requests.length;
  socket.close();
  context.mock.timers.tick(1000);
  await drain();
  assert.equal(requests.length, beforeClose + 1);
  ControlledWebSocket.instances[1].open();
  await drain();
});

test('close before open settles the caller and retries with a fresh ticket', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createService();
  const connection = service.connect();
  const failed = assert.rejects(connection, /closed before opening/);
  await drain();
  ControlledWebSocket.instances[0].close();
  await failed;
  context.mock.timers.tick(1000);
  await drain();
  assert.equal(requests.length, 2);
  assert.equal(ControlledWebSocket.instances.length, 2);
  assert.notEqual(
    ControlledWebSocket.instances[0].url,
    ControlledWebSocket.instances[1].url
  );
  ControlledWebSocket.instances[1].open();
  await drain();
  assert.equal(service.isConnected, true);
});

test('error followed by close schedules only one retry', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createService();
  const connection = service.connect();
  const failed = assert.rejects(connection);
  await drain();
  ControlledWebSocket.instances[0].failThenClose();
  await failed;
  context.mock.timers.tick(1000);
  await drain();
  assert.equal(requests.length, 2);
  ControlledWebSocket.instances[1].open();
  await drain();
  context.mock.timers.tick(120000);
  await drain();
  assert.equal(requests.length, 2);
});

for (const failure of [
  Object.assign(new Error('Unauthorized'), { response: { status: 401 } }),
  Object.assign(new Error('Forbidden'), { response: { status: 403 } }),
  new Error('Session expired'),
]) {
  test(`${failure.message} does not retry until an explicit reconnect`, async context => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const service = createService();
    requestTicket = async () => {
      throw failure;
    };
    await assert.rejects(service.connect(), error => error === failure);
    context.mock.timers.tick(120000);
    await drain();
    assert.equal(requests.length, 1);
    assert.equal(ControlledWebSocket.instances.length, 0);
    requestTicket = async () => ticketResponse('new-session-ticket');
    const reconnected = service.reconnect();
    await drain();
    ControlledWebSocket.instances[0].open();
    await reconnected;
    assert.equal(service.isConnected, true);
  });
}

test('disconnect cancels pending retry work and session replacement resets its timer', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createService();
  requestTicket = async () => {
    throw new Error('Offline');
  };
  await assert.rejects(service.connect(), /Offline/);
  context.mock.timers.tick(500);
  await assert.rejects(service.reconnect(), /Offline/);
  context.mock.timers.tick(500);
  await drain();
  assert.equal(requests.length, 2);
  context.mock.timers.tick(499);
  await drain();
  assert.equal(requests.length, 2);
  context.mock.timers.tick(1);
  await drain();
  assert.equal(requests.length, 3);
  service.disconnect();
  context.mock.timers.tick(120000);
  await drain();
  assert.equal(requests.length, 3);
});

test('concurrent connects share a request and superseded tickets cannot open a socket', async () => {
  const service = createService();
  let resolveOld!: (response: TicketResponse) => void;
  requestTicket = () =>
    new Promise(resolve => {
      resolveOld = resolve;
    });
  const oldConnection = service.connect();
  assert.equal(service.connect(), oldConnection);
  assert.equal(requests.length, 1);
  requestTicket = async () => ticketResponse('new-ticket');
  const currentConnection = service.reconnect();
  await drain();
  assert.equal(ControlledWebSocket.instances.length, 1);
  resolveOld(ticketResponse('stale-ticket'));
  await oldConnection;
  assert.equal(ControlledWebSocket.instances.length, 1);
  const current = ControlledWebSocket.instances[0];
  assert.equal(new URL(current.url).searchParams.get('ticket'), 'new-ticket');
  current.open();
  await currentConnection;
  assert.equal(service.isConnected, true);
});

test('a successful response without a ticket retries without opening an unauthenticated socket', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const service = createService();
  requestTicket = async () => ({ data: { success: false } });
  await assert.rejects(service.connect(), /did not issue a WebSocket ticket/);
  assert.equal(ControlledWebSocket.instances.length, 0);
  requestTicket = async () => ticketResponse('valid-ticket');
  context.mock.timers.tick(1000);
  await drain();
  assert.equal(requests.length, 2);
  ControlledWebSocket.instances[0].open();
  await drain();
  assert.equal(service.isConnected, true);
});

test('superseded sockets cannot deliver messages into the current session', async () => {
  const service = createService();
  const delivered: unknown[] = [];
  service.onMessage('test', message => delivered.push(message));
  const first = service.connect();
  await drain();
  const previous = ControlledWebSocket.instances[0];
  previous.open();
  await first;
  const second = service.reconnect();
  await drain();
  const current = ControlledWebSocket.instances[1];
  current.open();
  await second;
  previous.message('test', 'old-session-data');
  current.message('test', 'current-session-data');
  assert.deepEqual(delivered, ['current-session-data']);
});
