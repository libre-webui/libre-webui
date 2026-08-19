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

/*
 * The tool gateway (TOOL-02/TOOL-03): the egress guard, OpenAPI registration
 * and execution, per-user credential binding, pinned-spec refresh with
 * administrator overrides, the MCP Streamable HTTP client, per-server
 * visibility, and catalog namespacing.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-tool-gateway-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'tool-gateway-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '3'.repeat(64);
process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST = '127.0.0.1,localhost';

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const applicationPersistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const platformStorageModule = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await platformStorageModule.initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: encryptionService,
  env: process.env,
});

const [egress, toolServers, gateway, database] = await Promise.all([
  distModule('utils/toolEgress.js'),
  distModule('services/toolServerService.js'),
  distModule('services/toolGatewayService.js'),
  distModule('db.js'),
]);

const db = database.getDatabase();
const now = Date.now();
const createUser = (id, role) => {
  db.prepare(
    `INSERT INTO users
       (id, username, email, password_hash, role, account_status, avatar,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'unused', ?, 'active', NULL, ?, ?)`
  ).run(id, id, role, now, now);
  return { userId: id, role, status: 'active' };
};

const adminActor = createUser('tool-admin', 'admin');
const bobActor = createUser('tool-bob', 'user');

// === Mock OpenAPI server ===

const PET_SCHEMA = {
  type: 'object',
  properties: { name: { type: 'string' }, tag: { type: 'string' } },
  required: ['name'],
};

const specDocument = withDelete => ({
  openapi: '3.1.0',
  info: { title: 'Pet Store', version: '1.0.0' },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'List pets',
        parameters: [
          {
            name: 'limit',
            in: 'query',
            required: false,
            description: 'How many pets to return',
            schema: { type: 'integer' },
          },
        ],
      },
      post: {
        operationId: 'createPet',
        summary: 'Create a pet',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Pet' },
            },
          },
        },
      },
    },
    '/pets/{petId}': {
      get: {
        operationId: 'getPetById',
        summary: 'Fetch one pet',
        parameters: [
          {
            name: 'petId',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          { name: 'fields', in: 'query', schema: { type: 'string' } },
        ],
      },
      ...(withDelete
        ? {
            delete: {
              operationId: 'deletePet',
              summary: 'Delete one pet',
              parameters: [
                {
                  name: 'petId',
                  in: 'path',
                  required: true,
                  schema: { type: 'string' },
                },
              ],
            },
          }
        : {}),
    },
  },
  components: { schemas: { Pet: PET_SCHEMA } },
});

let serveDeleteOperation = false;
let lastHttpRequest = null;

const httpMock = createServer((request, response) => {
  const url = new URL(request.url, 'http://mock.invalid');
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    lastHttpRequest = {
      method: request.method,
      url: request.url,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: request.headers,
      body: Buffer.concat(chunks).toString('utf-8'),
    };
    if (url.pathname === '/' || url.pathname === '/openapi.json') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(specDocument(serveDeleteOperation)));
      return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { Location: 'http://127.0.0.1/elsewhere' });
      response.end();
      return;
    }
    if (url.pathname === '/big') {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('x'.repeat(8000));
      return;
    }
    if (url.pathname === '/pets/boom') {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'pet exploded' }));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      })
    );
  });
});

// === Mock MCP Streamable HTTP server ===

let mcpSessionCounter = 0;
const mcpRequestLog = [];

const mcpMock = createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    let payload = {};
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
    } catch {
      payload = {};
    }
    mcpRequestLog.push({
      method: payload.method,
      sessionId: request.headers['mcp-session-id'] ?? null,
      protocolVersion: request.headers['mcp-protocol-version'] ?? null,
      authorization: request.headers.authorization ?? null,
    });

    const reply = result => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    };

    if (payload.id === undefined) {
      // A JSON-RPC notification: acknowledge without a body.
      response.writeHead(202);
      response.end();
      return;
    }

    if (payload.method === 'initialize') {
      mcpSessionCounter += 1;
      response.writeHead(200, {
        'Content-Type': 'application/json',
        'Mcp-Session-Id': `mcp-session-${mcpSessionCounter}`,
      });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            protocolVersion: '2025-06-18',
            serverInfo: { name: 'mock-notes', version: '9.9' },
            capabilities: { tools: { listChanged: false } },
          },
        })
      );
      return;
    }

    if (payload.method === 'tools/list') {
      reply({
        tools: [
          {
            name: 'echo_note',
            description: 'Echo the arguments straight back',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
            },
            annotations: { readOnlyHint: true },
          },
          {
            name: 'write_note',
            description: 'Persist a note (side effecting)',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
            },
          },
        ],
      });
      return;
    }

    if (payload.method === 'tools/call') {
      const args = payload.params?.arguments ?? {};
      const body = {
        jsonrpc: '2.0',
        id: payload.id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(args) }],
          isError: false,
        },
      };
      if (payload.params?.name === 'write_note') {
        // Same response, framed as a single Server-Sent Event.
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        response.end(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: payload.id,
        error: { code: -32601, message: 'Method not found' },
      })
    );
  });
});

const listen = server =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });

const httpPort = await listen(httpMock);
const mcpPort = await listen(mcpMock);
const httpBase = `http://127.0.0.1:${httpPort}`;
const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

after(async () => {
  await new Promise(resolve => httpMock.close(resolve));
  await new Promise(resolve => mcpMock.close(resolve));
  database.closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

const ALLOWLIST = '127.0.0.1,localhost';
let petServer;
let openServer;
let grantedServer;
let mcpServer;

// === 1. Egress guard ===

test('without an allowlist, loopback destinations are refused', async () => {
  delete process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST;
  try {
    await assert.rejects(
      () =>
        egress.secureToolRequest({
          url: `${httpBase}/openapi.json`,
          method: 'GET',
          timeoutMs: 5000,
          maxResponseBytes: 65536,
        }),
      error => {
        assert.equal(error.name, 'ToolEgressError');
        assert.match(error.message, /private or local address/);
        return true;
      }
    );
    await assert.rejects(
      () =>
        toolServers.registerToolServer(adminActor.userId, {
          name: 'Blocked Store',
          kind: 'openapi',
          baseUrl: httpBase,
          authMode: 'none',
          accessMode: 'admins-only',
        }),
      error => /private or local address/.test(error.message)
    );
    assert.equal(egress.isAllowlistedPrivateHost('127.0.0.1'), false);
  } finally {
    process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST = ALLOWLIST;
  }
  assert.equal(egress.isAllowlistedPrivateHost('127.0.0.1'), true);
});

test('URLs carrying embedded credentials are refused', async () => {
  await assert.rejects(
    () =>
      egress.secureToolRequest({
        url: `http://user:secret@127.0.0.1:${httpPort}/openapi.json`,
        method: 'GET',
        timeoutMs: 5000,
        maxResponseBytes: 65536,
      }),
    error => {
      assert.equal(error.name, 'ToolEgressError');
      assert.match(error.message, /embedded credentials/);
      return true;
    }
  );
  assert.throws(
    () => egress.validateToolServerUrl('ftp://example.test/spec.json'),
    /http and https/
  );
});

test('a redirect response is refused rather than followed', async () => {
  await assert.rejects(
    () =>
      egress.secureToolRequest({
        url: `${httpBase}/redirect`,
        method: 'GET',
        timeoutMs: 5000,
        maxResponseBytes: 65536,
      }),
    error => {
      assert.equal(error.name, 'ToolEgressError');
      assert.match(error.message, /redirect/);
      return true;
    }
  );
});

test('an oversized response body is truncated with the flag set', async () => {
  const response = await egress.secureToolRequest({
    url: `${httpBase}/big`,
    method: 'GET',
    timeoutMs: 5000,
    maxResponseBytes: 1024,
  });
  assert.equal(response.status, 200);
  assert.equal(response.truncated, true);
  assert.equal(response.bodyText.length, 1024);

  const whole = await egress.secureToolRequest({
    url: `${httpBase}/big`,
    method: 'GET',
    timeoutMs: 5000,
    maxResponseBytes: 65536,
  });
  assert.equal(whole.truncated, false);
  assert.equal(whole.bodyText.length, 8000);
});

// === 2. OpenAPI registration ===

test('registering an OpenAPI server pins the spec and extracts its tools', async () => {
  petServer = await toolServers.registerToolServer(adminActor.userId, {
    name: 'Pet Store!',
    description: 'The mock pet store',
    kind: 'openapi',
    baseUrl: httpBase,
    specUrl: `${httpBase}/openapi.json`,
    authMode: 'bearer',
    accessMode: 'admins-only',
  });

  assert.equal(petServer.kind, 'openapi');
  assert.equal(petServer.specRevision, 1);
  assert.match(petServer.specDigest ?? '', /^[0-9a-f]{64}$/);
  assert.equal(petServer.authMode, 'bearer');
  assert.equal(petServer.enabled, true);
  assert.equal(petServer.ownerUserId, adminActor.userId);

  const tools = await toolServers.listServerTools(petServer.id);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'createPet',
    'getPetById',
    'listPets',
  ]);

  assert.equal(byName.get('listPets').sideEffect, false);
  assert.equal(byName.get('getPetById').sideEffect, false);
  assert.equal(byName.get('createPet').sideEffect, true);
  assert.equal(byName.get('listPets').enabled, true);

  assert.equal(byName.get('listPets').description, 'List pets');
  assert.deepEqual(byName.get('listPets').paramsSchema, {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many pets to return' },
    },
  });
  assert.deepEqual(byName.get('listPets').detail, {
    method: 'GET',
    path: '/pets',
    parameters: [{ name: 'limit', in: 'query', required: false }],
    hasBody: false,
  });

  const pet = byName.get('getPetById');
  assert.deepEqual(pet.paramsSchema.required, ['petId']);
  assert.deepEqual(Object.keys(pet.paramsSchema.properties).sort(), [
    'fields',
    'petId',
  ]);
  assert.deepEqual(pet.detail.parameters, [
    { name: 'petId', in: 'path', required: true },
    { name: 'fields', in: 'query', required: false },
  ]);

  const create = byName.get('createPet');
  assert.equal(create.detail.method, 'POST');
  assert.equal(create.detail.hasBody, true);
  assert.equal(create.detail.bodyContentType, 'application/json');
  assert.deepEqual(create.paramsSchema.required, ['body']);
  // The $ref into components/schemas is resolved into the argument schema.
  assert.deepEqual(create.paramsSchema.properties.body, PET_SCHEMA);
});

test('a non-JSON or non-3.x specification is rejected at registration', async () => {
  await assert.rejects(
    () =>
      toolServers.registerToolServer(adminActor.userId, {
        name: 'Not A Spec',
        kind: 'openapi',
        baseUrl: `${httpBase}/pets`,
        authMode: 'none',
        accessMode: 'admins-only',
      }),
    error => /OpenAPI 3/.test(error.message)
  );
});

// === 3. Catalog namespacing ===

test('the catalog namespaces server tools by a slug of the server name', async () => {
  const catalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [petServer.id],
      builtinTools: [],
    }
  );
  const names = catalog.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, [
    'pet_store__createPet',
    'pet_store__getPetById',
    'pet_store__listPets',
  ]);
  const entry = catalog.byName.get('pet_store__getPetById');
  assert.equal(entry.source, 'openapi');
  assert.equal(entry.serverId, petServer.id);
  assert.equal(entry.serverName, 'Pet Store!');
  assert.equal(entry.toolName, 'getPetById');
  assert.equal(toolServers.serverNamespace('Pet Store!'), 'pet_store');
});

// === 4. OpenAPI execution ===

test('executing an OpenAPI tool substitutes the path, encodes the query, and carries the bearer credential', async () => {
  await toolServers.setToolServerCredential(
    adminActor.userId,
    petServer.id,
    'pet-secret-token'
  );

  const catalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [petServer.id],
      builtinTools: [],
    }
  );
  const result = await gateway.executeToolCall({
    actor: adminActor,
    tool: catalog.byName.get('pet_store__getPetById'),
    argumentsJson: JSON.stringify({ petId: 'a b/c', fields: 'name,age' }),
  });

  assert.equal(result.isError, false, result.text);
  const echoed = JSON.parse(result.text);
  // The path segment is percent-encoded on the wire, so a value carrying a
  // slash cannot escape the pinned operation's path.
  assert.equal(echoed.path, '/pets/a%20b%2Fc');
  assert.equal(decodeURIComponent(echoed.path), '/pets/a b/c');
  assert.equal(lastHttpRequest.url, '/pets/a%20b%2Fc?fields=name%2Cage');
  assert.deepEqual(echoed.query, { fields: 'name,age' });
  assert.equal(echoed.headers.authorization, 'Bearer pet-secret-token');
  assert.equal(echoed.method, 'GET');
});

test('a POST tool sends the JSON body with its content type', async () => {
  const catalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [petServer.id],
      builtinTools: [],
    }
  );
  const result = await gateway.executeToolCall({
    actor: adminActor,
    tool: catalog.byName.get('pet_store__createPet'),
    argumentsJson: JSON.stringify({ body: { name: 'Rex', tag: 'dog' } }),
  });
  assert.equal(result.isError, false, result.text);
  assert.equal(lastHttpRequest.method, 'POST');
  assert.equal(lastHttpRequest.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(lastHttpRequest.body), {
    name: 'Rex',
    tag: 'dog',
  });
});

test('an HTTP 500 from the server surfaces as a tool error', async () => {
  const catalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [petServer.id],
      builtinTools: [],
    }
  );
  const result = await gateway.executeToolCall({
    actor: adminActor,
    tool: catalog.byName.get('pet_store__getPetById'),
    argumentsJson: JSON.stringify({ petId: 'boom' }),
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /HTTP 500/);
  assert.match(result.text, /pet exploded/);
});

test('a missing required parameter fails before any request leaves', async () => {
  const catalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [petServer.id],
      builtinTools: [],
    }
  );
  const result = await gateway.executeToolCall({
    actor: adminActor,
    tool: catalog.byName.get('pet_store__getPetById'),
    argumentsJson: JSON.stringify({ fields: 'name' }),
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /Missing required parameter: petId/);
});

// === 5. Credential AAD binding ===

test('the stored credential is ciphertext bound to one user and server', async () => {
  const row = db
    .prepare(
      'SELECT * FROM tool_server_credentials WHERE server_id = ? AND user_id = ?'
    )
    .get(petServer.id, adminActor.userId);
  assert.ok(row, 'the credential row exists');
  assert.ok(!row.secret.includes('pet-secret-token'));
  const raw = Buffer.from(row.secret, 'base64');
  assert.ok(!raw.toString('utf-8').includes('pet-secret-token'));
  assert.ok(!raw.toString('latin1').includes('pet-secret-token'));

  const aad = (serverId, userId) =>
    Buffer.from(`tool-server-credential\0${serverId}\0${userId}`, 'utf-8');

  assert.equal(
    encryptionService
      .decryptBuffer(raw, aad(petServer.id, adminActor.userId))
      .toString('utf-8'),
    'pet-secret-token'
  );
  assert.throws(() =>
    encryptionService.decryptBuffer(raw, aad(petServer.id, bobActor.userId))
  );
  assert.throws(() =>
    encryptionService.decryptBuffer(
      raw,
      aad('some-other-server', adminActor.userId)
    )
  );
  assert.throws(() => encryptionService.decryptBuffer(raw));

  // Without a personal credential the server refuses to build headers.
  await assert.rejects(
    () => toolServers.resolveAuthHeaders(bobActor.userId, petServer),
    /personal credential/
  );
});

// === 6. Refresh and administrator overrides ===

test('a refresh bumps the revision and preserves administrator overrides', async () => {
  const disabled = await toolServers.overrideServerTool(
    adminActor.userId,
    petServer.id,
    'listPets',
    { enabled: false }
  );
  assert.equal(disabled.enabled, false);

  const beforeCatalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [petServer.id],
      builtinTools: [],
    }
  );
  assert.equal(beforeCatalog.byName.has('pet_store__listPets'), false);

  serveDeleteOperation = true;
  const refreshed = await toolServers.refreshToolServer(
    adminActor.userId,
    petServer.id
  );
  assert.equal(refreshed.specRevision, 2);
  assert.notEqual(refreshed.specDigest, petServer.specDigest);

  const tools = await toolServers.listServerTools(petServer.id);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'createPet',
    'deletePet',
    'getPetById',
    'listPets',
  ]);
  assert.equal(byName.get('deletePet').sideEffect, true);
  assert.equal(
    byName.get('listPets').enabled,
    false,
    'the disabled override survives the refresh'
  );
  assert.equal(byName.get('getPetById').enabled, true);

  // A refresh with an unchanged spec leaves the revision alone.
  const again = await toolServers.refreshToolServer(
    adminActor.userId,
    petServer.id
  );
  assert.equal(again.specRevision, 2);
  petServer = again;
});

// === 7. MCP over Streamable HTTP ===

test('registering an MCP server pins its tools with the read-only classification', async () => {
  mcpRequestLog.length = 0;
  mcpServer = await toolServers.registerToolServer(adminActor.userId, {
    name: 'Notes MCP',
    kind: 'mcp',
    baseUrl: mcpUrl,
    authMode: 'none',
    accessMode: 'all-users',
  });
  assert.equal(mcpServer.kind, 'mcp');
  assert.equal(mcpServer.specRevision, 1);
  assert.match(mcpServer.specDigest ?? '', /^[0-9a-f]{64}$/);

  const tools = await toolServers.listServerTools(mcpServer.id);
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    'echo_note',
    'write_note',
  ]);
  assert.equal(byName.get('echo_note').sideEffect, false);
  assert.equal(byName.get('write_note').sideEffect, true);
  assert.deepEqual(byName.get('echo_note').paramsSchema, {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  });

  const methods = mcpRequestLog.map(entry => entry.method);
  assert.deepEqual(methods, [
    'initialize',
    'notifications/initialized',
    'tools/list',
  ]);
  const issued = mcpRequestLog[0].sessionId;
  assert.equal(issued, null, 'initialize carries no session id yet');
  assert.equal(mcpRequestLog[2].sessionId, `mcp-session-${mcpSessionCounter}`);
  assert.equal(mcpRequestLog[2].protocolVersion, '2025-06-18');
});

test('an MCP tool call echoes the arguments and reuses the issued session id', async () => {
  mcpRequestLog.length = 0;
  const catalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [mcpServer.id],
      builtinTools: [],
    }
  );
  assert.deepEqual(catalog.tools.map(tool => tool.name).sort(), [
    'notes_mcp__echo_note',
    'notes_mcp__write_note',
  ]);

  const result = await gateway.executeToolCall({
    actor: adminActor,
    tool: catalog.byName.get('notes_mcp__echo_note'),
    argumentsJson: JSON.stringify({ text: 'hello mcp' }),
  });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(JSON.parse(result.text), { text: 'hello mcp' });

  assert.deepEqual(
    mcpRequestLog.map(entry => entry.method),
    ['initialize', 'notifications/initialized', 'tools/call']
  );
  const sessionId = `mcp-session-${mcpSessionCounter}`;
  assert.equal(mcpRequestLog[0].sessionId, null);
  assert.equal(
    mcpRequestLog[2].sessionId,
    sessionId,
    'the session id from initialize rides along on tools/call'
  );
});

test('an SSE-framed MCP response is parsed like a JSON one', async () => {
  const catalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [mcpServer.id],
      builtinTools: [],
    }
  );
  const result = await gateway.executeToolCall({
    actor: adminActor,
    tool: catalog.byName.get('notes_mcp__write_note'),
    argumentsJson: JSON.stringify({ text: 'written over SSE' }),
  });
  assert.equal(result.isError, false, result.text);
  assert.deepEqual(JSON.parse(result.text), { text: 'written over SSE' });
});

// === 8. Per-server visibility ===

test('access modes scope which servers a non-admin can see', async () => {
  openServer = await toolServers.registerToolServer(adminActor.userId, {
    name: 'Open Store',
    kind: 'openapi',
    baseUrl: httpBase,
    authMode: 'none',
    accessMode: 'all-users',
  });
  grantedServer = await toolServers.registerToolServer(adminActor.userId, {
    name: 'Granted Store',
    kind: 'openapi',
    baseUrl: httpBase,
    authMode: 'none',
    accessMode: 'granted',
  });

  const adminVisible = await toolServers.listVisibleToolServers(adminActor);
  assert.equal(
    adminVisible.filter(server => server.id === petServer.id).length,
    1
  );

  let visible = await toolServers.listVisibleToolServers(bobActor);
  let ids = visible.map(server => server.id);
  assert.equal(ids.includes(petServer.id), false, 'admins-only stays hidden');
  assert.equal(ids.includes(openServer.id), true, 'all-users is visible');
  assert.equal(ids.includes(mcpServer.id), true);
  assert.equal(ids.includes(grantedServer.id), false, 'granted needs a grant');

  let catalog = await toolServers.effectiveServerTools(bobActor);
  assert.equal(
    catalog.some(tool => tool.serverId === petServer.id),
    false
  );
  assert.equal(
    catalog.some(tool => tool.serverId === grantedServer.id),
    false
  );
  assert.equal(
    catalog.some(tool => tool.serverId === openServer.id),
    true
  );

  db.prepare(
    `INSERT INTO resource_grants
       (id, resource_type, resource_id, owner_user_id, principal_type,
        principal_id, permission, created_by, created_at)
     VALUES (?, 'tool-server', ?, ?, 'user', ?, 'read', ?, ?)`
  ).run(
    'grant-tool-server-1',
    grantedServer.id,
    adminActor.userId,
    bobActor.userId,
    adminActor.userId,
    Date.now()
  );

  visible = await toolServers.listVisibleToolServers(bobActor);
  ids = visible.map(server => server.id);
  assert.equal(ids.includes(grantedServer.id), true, 'the grant opens it');
  assert.equal(ids.includes(petServer.id), false);

  catalog = await toolServers.effectiveServerTools(bobActor, [
    grantedServer.id,
  ]);
  assert.equal(catalog.length > 0, true);
  assert.equal(
    catalog.every(tool => tool.serverId === grantedServer.id),
    true
  );

  // Disabling the server removes it for everyone, admins included.
  await toolServers.updateToolServer(adminActor.userId, openServer.id, {
    enabled: false,
  });
  assert.equal(
    (await toolServers.listVisibleToolServers(bobActor))
      .map(server => server.id)
      .includes(openServer.id),
    false
  );
  assert.equal(
    (await toolServers.listVisibleToolServers(adminActor))
      .map(server => server.id)
      .includes(openServer.id),
    false
  );
  await toolServers.updateToolServer(adminActor.userId, openServer.id, {
    enabled: true,
  });
});

test('a call resolved against a server the actor lost access to is refused', async () => {
  const catalog = await gateway.buildToolCatalog(
    adminActor,
    {},
    {
      serverIds: [petServer.id],
      builtinTools: [],
    }
  );
  const tool = catalog.byName.get('pet_store__getPetById');
  const result = await gateway.executeToolCall({
    actor: bobActor,
    tool,
    argumentsJson: JSON.stringify({ petId: '7' }),
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /no longer available/);
});

test('a call naming a tool the administrator disabled is refused', async () => {
  const disabledTool = {
    name: 'pet_store__listPets',
    sideEffect: false,
    source: 'openapi',
    serverId: petServer.id,
    serverName: 'Pet Store!',
    toolName: 'listPets',
  };
  const result = await gateway.executeToolCall({
    actor: adminActor,
    tool: disabledTool,
    argumentsJson: '{}',
  });
  assert.equal(result.isError, true);
  assert.match(result.text, /no longer offered/);
});

test('the tools feature gate follows the tool access mode', async () => {
  assert.equal(await gateway.actorCanUseTools(adminActor), true);
  assert.equal(await gateway.actorCanUseTools(bobActor), false);
  process.env.TOOLS_ACCESS_MODE = 'all-users';
  try {
    assert.equal(await gateway.actorCanUseTools(bobActor), true);
  } finally {
    delete process.env.TOOLS_ACCESS_MODE;
  }
  assert.equal(await gateway.actorCanUseTools(bobActor), false);
});

test('deleting a server drops its tools and its grants', async () => {
  assert.equal(
    await toolServers.deleteToolServer(adminActor.userId, grantedServer.id),
    true
  );
  assert.equal(await toolServers.getToolServer(grantedServer.id), null);
  assert.deepEqual(await toolServers.listServerTools(grantedServer.id), []);
  const remaining = db
    .prepare(
      "SELECT COUNT(*) AS count FROM resource_grants WHERE resource_type = 'tool-server' AND resource_id = ?"
    )
    .get(grantedServer.id);
  assert.equal(remaining.count, 0);
});
