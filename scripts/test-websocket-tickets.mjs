import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const distRoot = path.join(repoRoot, 'backend', 'dist');
const { WebSocketTicketService } = await import(
  pathToFileURL(
    path.join(distRoot, 'services', 'websocketTicketService.js')
  ).href
);

test('WebSocket tickets are opaque, single-use, and user-bound', () => {
  const service = new WebSocketTicketService(30_000);
  const sessionExpiresAt = Date.now() + 60_000;
  const issued = service.issue('user-a', sessionExpiresAt, 'chat');

  assert.match(issued.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(service.consume(issued.ticket, 'chat'), {
    userId: 'user-a',
    sessionExpiresAt,
  });
  assert.equal(service.consume(issued.ticket, 'chat'), null);
});

test('expired WebSocket tickets cannot be consumed', () => {
  let now = 1_000;
  const service = new WebSocketTicketService(500, () => now);
  const issued = service.issue('user-a', now + 60_000, 'chat');
  now += 500;

  assert.equal(service.consume(issued.ticket, 'chat'), null);
});

test('a WebSocket ticket cannot outlive its authenticated session', () => {
  let now = 1_000;
  const service = new WebSocketTicketService(30_000, () => now);
  const issued = service.issue('user-a', now + 250, 'chat');
  now += 250;

  assert.equal(service.consume(issued.ticket, 'chat'), null);
});

test('tickets are bound to one WebSocket protocol and Work task', () => {
  const service = new WebSocketTicketService(30_000);
  const expiresAt = Date.now() + 60_000;
  const wrongProtocol = service.issue(
    'user-a',
    expiresAt,
    'work-terminal',
    'task-a'
  );
  assert.equal(service.consume(wrongProtocol.ticket, 'chat'), null);

  const wrongTask = service.issue(
    'user-a',
    expiresAt,
    'work-terminal',
    'task-a'
  );
  assert.equal(
    service.consume(wrongTask.ticket, 'work-terminal', 'task-b'),
    null
  );
});

test('chat WebSockets never put durable bearer tokens in URLs', () => {
  const server = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'websocketServer.ts'),
    'utf8'
  );
  const client = fs.readFileSync(
    path.join(repoRoot, 'frontend', 'src', 'utils', 'websocket.ts'),
    'utf8'
  );
  const routes = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'auth.ts'),
    'utf8'
  );
  const terminal = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'workTerminalServer.ts'),
    'utf8'
  );
  const terminalClient = fs.readFileSync(
    path.join(repoRoot, 'frontend', 'src', 'utils', 'api', 'workTerminal.ts'),
    'utf8'
  );

  assert.match(server, /searchParams\.get\('ticket'\)/);
  assert.match(
    server,
    /websocketTicketService\.consume\(ticket,\s*'chat'\)/
  );
  assert.doesNotMatch(server, /searchParams\.get\('token'\)/);
  assert.match(client, /\/auth\/websocket-ticket/);
  assert.match(client, /\?ticket=/);
  assert.doesNotMatch(client, /\?token=/);
  assert.match(routes, /'\/websocket-ticket'/);
  assert.match(routes, /Cache-Control', 'no-store'/);
  assert.match(routes, /authenticate/);
  assert.match(terminal, /consume\([\s\S]*?'work-terminal'/);
  assert.doesNotMatch(terminal, /searchParams\.get\('token'\)/);
  assert.match(terminalClient, /audience: 'work-terminal'/);
  assert.doesNotMatch(terminalClient, /localStorage|get\('auth-token'\)/);
});
