import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';
import { tsImport } from 'tsx/esm/api';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const distRoot = path.join(repoRoot, 'backend', 'dist');
const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-websocket-tickets-')
);
process.env.DATA_DIR = path.join(testRoot, 'data');
process.env.ENCRYPTION_KEY = '1'.repeat(64);
process.env.JWT_SECRET = 'websocket-ticket-canary-secret';
process.env.CORS_ORIGIN = 'http://allowed.example.test';

const importDist = relativePath =>
  import(pathToFileURL(path.join(distRoot, relativePath)).href);

const coordinationModule = await importDist('platform/coordination/service.js');
await coordinationModule.initializeCoordinator();

const [
  databaseModule,
  { authService },
  { default: authRouter },
  {
    WebSocketTicketCoordinationError,
    WebSocketTicketService,
    websocketTicketService,
  },
  { registerWebSocketServer },
  { userModel },
  frontendUrls,
] = await Promise.all([
  importDist('db.js'),
  importDist('services/authService.js'),
  importDist('routes/auth.js'),
  importDist('services/websocketTicketService.js'),
  importDist('websocketServer.js'),
  importDist('models/userModel.js'),
  tsImport(
    path.join(repoRoot, 'frontend', 'src', 'utils', 'websocketUrl.ts'),
    import.meta.url
  ),
]);
const { buildChatWebSocketUrl, buildWorkTerminalUrl, resolveWebSocketBaseUrl } =
  frontendUrls;

const database = databaseModule.getDatabase();
const now = Date.now();
const user = {
  id: 'websocket-canary-user',
  username: 'PROXY_LOG_DURABLE_SESSION_CANARY',
  email: null,
  role: 'user',
  status: 'active',
  avatar: null,
  approvedAt: null,
  approvedBy: null,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
};
database
  .prepare(
    `INSERT INTO users
       (id, username, email, password_hash, role, account_status, avatar,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'unused', ?, 'active', NULL, ?, ?)`
  )
  .run(user.id, user.username, user.role, now, now);

const durableSessionCanary = authService.generateToken(user);
const requestLog = [];
const app = express();
app.use(express.json({ limit: '16kb' }));
app.use('/api/auth', authRouter);
const server = http.createServer(app);
server.prependListener('request', request => {
  requestLog.push({
    transport: 'http',
    target: request.url || '',
    authorization: request.headers.authorization,
  });
});
server.prependListener('upgrade', request => {
  requestLog.push({
    transport: 'upgrade',
    target: request.url || '',
    authorization: request.headers.authorization,
  });
});
const registeredWebSockets = registerWebSocketServer(server);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const httpBase = `http://127.0.0.1:${address.port}`;
const webSocketBase = `ws://127.0.0.1:${address.port}`;
const browserEnvironment = {
  protocol: 'https:',
  host: 'ignored-browser.example.test',
  hostname: 'ignored-browser.example.test',
  apiBaseUrl: 'https://ignored-api.example.test/api',
  websocketBaseUrl: webSocketBase,
  production: true,
};
const WEBSOCKET_TEST_TIMEOUT_MS = 5_000;

after(async () => {
  await registeredWebSockets.close();
  await new Promise(resolve => server.close(resolve));
  await coordinationModule.closeCoordinator();
  databaseModule.closeDatabase();
  fs.rmSync(testRoot, { recursive: true, force: true });
});

async function fetchTicket(audience, taskId) {
  const response = await fetch(`${httpBase}/api/auth/websocket-ticket`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${durableSessionCanary}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ audience, ...(taskId ? { taskId } : {}) }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') || '', /no-store/);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.match(body.data.ticket, /^[A-Za-z0-9_-]{43}$/);
  return body.data;
}

function openWebSocket(url, origin = 'http://allowed.example.test') {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, origin === null ? {} : { origin });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out opening WebSocket ${url}`));
    }, WEBSOCKET_TEST_TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      reject(new Error(`Unexpected upgrade status ${response.statusCode}`));
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function expectUpgradeStatus(
  url,
  expectedStatus,
  origin = 'http://allowed.example.test'
) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    let receivedHttpStatus = false;
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out waiting for upgrade status ${url}`));
    }, WEBSOCKET_TEST_TIMEOUT_MS);
    socket.once('open', () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error(`WebSocket unexpectedly opened for ${url}`));
    });
    socket.once('unexpected-response', (_request, response) => {
      receivedHttpStatus = true;
      clearTimeout(timeout);
      const status = response.statusCode;
      response.resume();
      if (status === expectedStatus) resolve();
      else reject(new Error(`Expected ${expectedStatus}, received ${status}`));
    });
    socket.once('error', error => {
      // ws emits an error after some rejected handshakes. The HTTP status above
      // is the authoritative result and settles this promise first.
      if (!receivedHttpStatus) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

function expectAuthenticatedSocketClose(url, expectedCode) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, {
      origin: 'http://allowed.example.test',
    });
    let opened = false;
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Timed out waiting for authenticated close ${url}`));
    }, WEBSOCKET_TEST_TIMEOUT_MS);
    socket.once('open', () => {
      opened = true;
    });
    socket.once('unexpected-response', (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      reject(
        new Error(`Upgrade was rejected with status ${response.statusCode}`)
      );
    });
    socket.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once('close', code => {
      clearTimeout(timeout);
      if (!opened) reject(new Error('WebSocket closed before opening'));
      else if (code !== expectedCode) {
        reject(
          new Error(`Expected close code ${expectedCode}, received ${code}`)
        );
      } else resolve();
    });
  });
}

async function closeWebSocket(socket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error('Timed out closing WebSocket'));
    }, WEBSOCKET_TEST_TIMEOUT_MS);
    socket.once('close', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  socket.close(1000, 'test-complete');
  await closed;
}

test('WebSocket tickets rotate, are opaque, and are single-use', async () => {
  const service = new WebSocketTicketService(30_000);
  const sessionExpiresAt = Date.now() + 60_000;
  const first = await service.issue('user-a', sessionExpiresAt, 'chat');
  const rotated = await service.issue('user-a', sessionExpiresAt, 'chat');

  assert.match(first.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.match(rotated.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.ticket, rotated.ticket);
  assert.deepEqual(await service.consume(first.ticket, 'chat'), {
    userId: 'user-a',
    sessionExpiresAt,
  });
  assert.equal(await service.consume(first.ticket, 'chat'), null);
});

test('expired tickets and tickets from expired sessions cannot be consumed', async () => {
  let clock = 1_000;
  const service = new WebSocketTicketService(500, () => clock);
  const ticketExpired = await service.issue('user-a', clock + 60_000, 'chat');
  clock += 500;
  assert.equal(await service.consume(ticketExpired.ticket, 'chat'), null);

  const sessionExpired = await service.issue('user-a', clock + 250, 'chat');
  clock += 250;
  assert.equal(await service.consume(sessionExpired.ticket, 'chat'), null);
});

test('wrong audience and Work task attempts consume the ticket', async () => {
  const service = new WebSocketTicketService(30_000);
  const expiresAt = Date.now() + 60_000;
  const wrongAudience = await service.issue(
    'user-a',
    expiresAt,
    'work-terminal',
    'task-a'
  );
  assert.equal(await service.consume(wrongAudience.ticket, 'chat'), null);
  assert.equal(
    await service.consume(wrongAudience.ticket, 'work-terminal', 'task-a'),
    null
  );

  const wrongTask = await service.issue(
    'user-a',
    expiresAt,
    'work-terminal',
    'task-a'
  );
  assert.equal(
    await service.consume(wrongTask.ticket, 'work-terminal', 'task-b'),
    null
  );
  assert.equal(
    await service.consume(wrongTask.ticket, 'work-terminal', 'task-a'),
    null
  );
});

test('independent replicas consume one shared ticket exactly once', async () => {
  const coordinator = coordinationModule.getCoordinator();
  const firstReplica = new WebSocketTicketService(
    30_000,
    Date.now,
    () => coordinator
  );
  const secondReplica = new WebSocketTicketService(
    30_000,
    Date.now,
    () => coordinator
  );
  const sessionExpiresAt = Date.now() + 60_000;
  const issued = await firstReplica.issue(
    'cross-replica-user',
    sessionExpiresAt,
    'chat'
  );

  assert.deepEqual(await secondReplica.consume(issued.ticket, 'chat'), {
    userId: 'cross-replica-user',
    sessionExpiresAt,
  });
  assert.equal(await firstReplica.consume(issued.ticket, 'chat'), null);
});

test('WebSocket ticket coordination stalls fail closed within a deadline', async () => {
  const stalledCoordinator = {
    consumeRateLimit: () => new Promise(() => {}),
    setCache: () => new Promise(() => {}),
    consumeCache: () => new Promise(() => {}),
  };
  const service = new WebSocketTicketService(
    30_000,
    Date.now,
    () => stalledCoordinator,
    10
  );
  const issueStartedAt = Date.now();
  await assert.rejects(
    () => service.issue('stalled-user', Date.now() + 60_000, 'chat'),
    /timed out/
  );
  assert.ok(Date.now() - issueStartedAt < 200);

  const local = new WebSocketTicketService(30_000);
  const opaqueTicket = await local.issue(
    'stalled-user',
    Date.now() + 60_000,
    'chat'
  );
  const consumeStartedAt = Date.now();
  await assert.rejects(
    () => service.consume(opaqueTicket.ticket, 'chat'),
    error => {
      assert.ok(error instanceof WebSocketTicketCoordinationError);
      assert.equal(error.cause?.name, 'CoordinationOperationTimeoutError');
      return true;
    }
  );
  assert.ok(Date.now() - consumeStartedAt < 200);
});

test('production exchange, frontend URL, and chat upgrade keep JWTs out of logs', async () => {
  const first = await fetchTicket('chat');
  const rotated = await fetchTicket('chat');
  assert.notEqual(first.ticket, rotated.ticket);

  const chatUrl = buildChatWebSocketUrl(first.ticket, browserEnvironment);
  assert.equal(new URL(chatUrl).origin, webSocketBase);
  assert.equal(new URL(chatUrl).pathname, '/ws');
  assert.equal(new URL(chatUrl).searchParams.get('ticket'), first.ticket);
  assert.equal(chatUrl.includes(durableSessionCanary), false);
  assert.equal(new URL(chatUrl).searchParams.has('token'), false);

  const socket = await openWebSocket(chatUrl);
  await closeWebSocket(socket);
  await expectUpgradeStatus(chatUrl, 401);

  const requestTargets = requestLog.map(entry => entry.target).join('\n');
  assert.equal(requestTargets.includes(durableSessionCanary), false);
  assert.doesNotMatch(requestTargets, /[?&]token=/);
  const upgradeEntries = requestLog.filter(
    entry => entry.transport === 'upgrade'
  );
  assert.ok(upgradeEntries.length >= 2);
  assert.ok(upgradeEntries.every(entry => entry.authorization === undefined));
  const exchangeEntries = requestLog.filter(
    entry => entry.transport === 'http'
  );
  assert.ok(exchangeEntries.length >= 2);
  assert.ok(
    exchangeEntries.every(
      entry => entry.authorization === `Bearer ${durableSessionCanary}`
    )
  );

  // A second issued ticket remains valid after rotation; issuing a replacement
  // never causes the durable login credential to enter the upgrade request.
  const rotatedSocket = await openWebSocket(
    buildChatWebSocketUrl(rotated.ticket, browserEnvironment)
  );
  await closeWebSocket(rotatedSocket);
});

test('production upgrade rejects wrong audience, disallowed origin, and inactive accounts', async () => {
  const workTicket = await fetchTicket('work-terminal', 'task-a');
  await expectUpgradeStatus(
    buildChatWebSocketUrl(workTicket.ticket, browserEnvironment),
    401
  );

  const originTicket = await fetchTicket('chat');
  const originUrl = buildChatWebSocketUrl(
    originTicket.ticket,
    browserEnvironment
  );
  await expectUpgradeStatus(originUrl, 403, 'https://evil.example.test');
  // Origin rejection happens before ticket consumption, so a legitimate
  // browser can still use the same one-use credential.
  const allowedSocket = await openWebSocket(originUrl);
  await closeWebSocket(allowedSocket);

  const originlessTicket = await fetchTicket('chat');
  const originlessSocket = await openWebSocket(
    buildChatWebSocketUrl(originlessTicket.ticket, browserEnvironment),
    null
  );
  await closeWebSocket(originlessSocket);

  const inactiveTicket = await fetchTicket('chat');
  database
    .prepare('UPDATE users SET account_status = ? WHERE id = ?')
    .run('pending', user.id);
  await expectUpgradeStatus(
    buildChatWebSocketUrl(inactiveTicket.ticket, browserEnvironment),
    401
  );
  database
    .prepare('UPDATE users SET account_status = ? WHERE id = ?')
    .run('active', user.id);
  await expectUpgradeStatus(
    buildChatWebSocketUrl(inactiveTicket.ticket, browserEnvironment),
    401
  );
});

test('production Work upgrade applies task-bound ticket authentication', async () => {
  const ticket = await fetchTicket('work-terminal', 'task-a');
  const wrongTaskUrl = buildWorkTerminalUrl(
    'task-b',
    ticket.ticket,
    browserEnvironment
  );
  assert.equal(new URL(wrongTaskUrl).pathname, '/ws/work-terminal');
  assert.equal(new URL(wrongTaskUrl).searchParams.get('taskId'), 'task-b');
  assert.equal(wrongTaskUrl.includes(durableSessionCanary), false);
  await expectAuthenticatedSocketClose(wrongTaskUrl, 4401);
});

test('VITE_WS_BASE_URL is shared, path-aware, and validated', () => {
  const environment = {
    ...browserEnvironment,
    websocketBaseUrl: 'wss://socket.example.test/libre/',
  };
  assert.equal(
    resolveWebSocketBaseUrl(environment),
    'wss://socket.example.test/libre'
  );
  assert.equal(
    buildChatWebSocketUrl('ticket-a', environment),
    'wss://socket.example.test/libre/ws?ticket=ticket-a'
  );
  assert.equal(
    buildWorkTerminalUrl('task/a', 'ticket-b', environment),
    'wss://socket.example.test/libre/ws/work-terminal?taskId=task%2Fa&ticket=ticket-b'
  );
  assert.throws(
    () =>
      resolveWebSocketBaseUrl({
        ...environment,
        websocketBaseUrl: 'https://socket.example.test',
      }),
    /must use ws: or wss:/
  );
  assert.throws(
    () =>
      resolveWebSocketBaseUrl({
        ...environment,
        websocketBaseUrl: 'wss://user:secret@socket.example.test',
      }),
    /must not contain credentials/
  );
  assert.throws(
    () =>
      resolveWebSocketBaseUrl({
        ...environment,
        websocketBaseUrl: 'wss://socket.example.test?token=durable',
      }),
    /must not contain credentials/
  );
});

test('shutdown drains in-flight chat handlers without unhandled rejection', async t => {
  const isolatedServer = http.createServer(express());
  const isolatedWebSockets = registerWebSocketServer(isolatedServer);
  await new Promise((resolve, reject) => {
    isolatedServer.once('error', reject);
    isolatedServer.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await isolatedWebSockets.close();
    await new Promise(resolve => isolatedServer.close(resolve));
  });

  const isolatedAddress = isolatedServer.address();
  assert.ok(isolatedAddress && typeof isolatedAddress === 'object');
  const issued = await websocketTicketService.issue(
    user.id,
    Date.now() + 60_000,
    'chat'
  );
  const client = await openWebSocket(
    `ws://127.0.0.1:${isolatedAddress.port}/ws?ticket=${issued.ticket}`
  );

  const originalGetUserById = userModel.getUserById;
  let releaseLookup;
  const lookupBlocked = new Promise(resolve => {
    releaseLookup = resolve;
  });
  let lookupStarted;
  const didStartLookup = new Promise(resolve => {
    lookupStarted = resolve;
  });
  userModel.getUserById = async () => {
    lookupStarted();
    await lookupBlocked;
    throw new Error('late shutdown lookup failure');
  };
  t.after(() => {
    userModel.getUserById = originalGetUserById;
  });

  const unhandledRejections = [];
  const captureUnhandledRejection = reason => unhandledRejections.push(reason);
  process.on('unhandledRejection', captureUnhandledRejection);
  try {
    client.send(JSON.stringify({ type: 'ignored-during-shutdown' }));
    await didStartLookup;

    let shutdownSettled = false;
    const shutdown = isolatedWebSockets.close().then(() => {
      shutdownSettled = true;
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      shutdownSettled,
      false,
      'shutdown must retain the database boundary until handlers settle'
    );

    releaseLookup();
    await shutdown;
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', captureUnhandledRejection);
    userModel.getUserById = originalGetUserById;
    releaseLookup?.();
    client.terminate();
  }
});
