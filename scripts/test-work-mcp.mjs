import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-work-mcp-'));

process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST = '127.0.0.1,localhost';
// Deterministic provider scripting (see test-work-delegation.mjs).
process.env.WORK_STATUS_BLURB_MODEL = '0';

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );
const [
  { getDatabase },
  { default: workAgentService },
  { default: workApprovalService },
  { default: workEventService },
  { default: workModelProviderService },
  { default: workRuntimeService },
  { default: workTaskService },
  toolServers,
] = await Promise.all([
  distModule('db.js'),
  distModule('services/workAgentService.js'),
  distModule('services/workApprovalService.js'),
  distModule('services/workEventService.js'),
  distModule('services/workModelProviderService.js'),
  distModule('services/workRuntimeService.js'),
  distModule('services/workTaskService.js'),
  distModule('services/toolServerService.js'),
]);
const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);

const restorers = [];
const replaceMethod = (target, key, replacement) => {
  const hadOwnProperty = Object.hasOwn(target, key);
  const previous = target[key];
  target[key] = replacement;
  restorers.push(() => {
    if (hadOwnProperty) target[key] = previous;
    else delete target[key];
  });
};

replaceMethod(
  workModelProviderService,
  'getRoutingFingerprint',
  () => 'stable-work-routing'
);
replaceMethod(workRuntimeService, 'prepare', async () => () => undefined);
replaceMethod(workRuntimeService, 'isPreviewRunning', async () => false);
replaceMethod(workRuntimeService, 'stopContainer', async () => undefined);

// A minimal MCP server over Streamable HTTP (mirrors test-tool-gateway).
const mcpCalls = [];
let mcpSessionCounter = 0;
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
    if (payload.method === 'tools/call') {
      mcpCalls.push({
        name: payload.params?.name,
        args: payload.params?.arguments ?? {},
        authorization: request.headers.authorization ?? null,
      });
    }
    if (payload.id === undefined) {
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
            serverInfo: { name: 'mock-notes', version: '1.0' },
            capabilities: { tools: { listChanged: false } },
          },
        })
      );
      return;
    }
    if (payload.method === 'tools/list') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
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
          },
        })
      );
      return;
    }
    if (payload.method === 'tools/call') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify(payload.params?.arguments ?? {}),
              },
            ],
            isError: false,
          },
        })
      );
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
const mcpPort = await new Promise((resolve, reject) => {
  mcpMock.once('error', reject);
  mcpMock.listen(0, '127.0.0.1', () => resolve(mcpMock.address().port));
});
const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

after(async () => {
  for (const restore of restorers.reverse()) restore();
  workEventService.reset();
  await new Promise(resolve => mcpMock.close(resolve));
  await closeWorkPlatform();
  await rm(dataDir, { recursive: true, force: true });
});

const userId = 'work-mcp-admin';
const provider = { providerType: 'plugin', providerId: 'test-plugin' };

const providerScript = [];
replaceMethod(
  workModelProviderService,
  'generateChatStreamResponse',
  async (request, _provider, _userId, observer) => {
    const step = providerScript.shift();
    assert.ok(step, 'provider was called with no scripted turn left');
    return step(request, observer);
  }
);
const textTurn = content => (request, observer) => {
  observer?.onContent?.(content);
  return {
    model: request.model,
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content },
    done: true,
  };
};
const toolTurn = (id, name, args) => request => ({
  model: request.model,
  created_at: new Date().toISOString(),
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, function: { name, arguments: args } }],
  },
  done: true,
});
const toolNames = request =>
  request.tools.map(schema => schema.function?.name ?? '');

test.before(() => {
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);
});

test('connected tools reach network-enabled runs and stay off offline ones', async () => {
  await toolServers.registerToolServer(userId, {
    name: 'Notes MCP',
    kind: 'mcp',
    baseUrl: mcpUrl,
    authMode: 'none',
    accessMode: 'all-users',
  });

  // An offline task never sees connected tools: backend egress or not, an
  // offline task stays offline (the web_search rationale).
  providerScript.push((request, observer) => {
    assert.equal(
      toolNames(request).some(name => name.startsWith('notes_mcp__')),
      false,
      'offline runs must not offer connected tools'
    );
    return textTurn('Offline done.')(request, observer);
  });
  const offline = await workTaskService.createTaskWithRun(
    userId,
    'Offline task',
    'test-model',
    false,
    provider
  );
  await workAgentService.execute(offline.id, offline.activeRun.id, userId);
  assert.equal(
    (await workTaskService.getRun(offline.activeRun.id)).status,
    'completed'
  );

  // A network-enabled run offers the namespaced tools and a call round-trips
  // through the hardened gateway to the MCP server.
  providerScript.push(
    (request, observer) => {
      const names = toolNames(request);
      assert.ok(names.includes('notes_mcp__echo_note'), names.join(','));
      assert.ok(names.includes('notes_mcp__write_note'));
      // The prompt tells the agent these run outside its sandbox.
      assert.match(request.messages[0].content, /Connected tools/);
      assert.match(request.messages[0].content, /notes_mcp__echo_note/);
      return toolTurn('call-1', 'notes_mcp__echo_note', {
        text: 'from work',
      })(request, observer);
    },
    textTurn('Echoed.')
  );
  const online = await workTaskService.createTaskWithRun(
    userId,
    'Online task',
    'test-model',
    true,
    provider
  );
  await workAgentService.execute(online.id, online.activeRun.id, userId);
  assert.equal(
    (await workTaskService.getRun(online.activeRun.id)).status,
    'completed'
  );
  const messages = await workTaskService.getMessages(online.id);
  const result = messages.findLast(message => message.kind === 'tool_result');
  assert.deepEqual(JSON.parse(result.content), { text: 'from work' });
  assert.equal(result.metadata.external, true);
  assert.equal(result.metadata.server, 'Notes MCP');
  assert.deepEqual(mcpCalls.at(-1), {
    name: 'echo_note',
    args: { text: 'from work' },
    authorization: null,
  });
});

test('side-effecting connected tools pause for approval; read-only ones run free', async () => {
  const task = await workTaskService.createTaskWithRun(
    userId,
    'Reviewed task',
    'test-model',
    true,
    provider
  );
  providerScript.push(textTurn('Hired.'));
  await workAgentService.execute(task.id, task.activeRun.id, userId);
  await workTaskService.setTaskApprovals(task.id, userId, true);

  providerScript.push(
    toolTurn('call-2', 'notes_mcp__echo_note', { text: 'no gate' }),
    toolTurn('call-3', 'notes_mcp__write_note', { text: 'gated' }),
    textTurn('Wrote the note.')
  );
  const run = await workTaskService.createRun(task.id, userId, 'Write it.');
  const execution = workAgentService.execute(
    task.id,
    run.activeRun.id,
    userId
  );
  // The read-only call runs without an approval; the side-effecting one
  // pauses until we decide.
  let pending = [];
  for (let attempt = 0; attempt < 200; attempt += 1) {
    pending = await workApprovalService.listPending(task.id);
    if (pending.length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(pending.length, 1);
  assert.equal(pending[0].name, 'notes_mcp__write_note');
  const echoRan = mcpCalls.some(
    call => call.name === 'echo_note' && call.args.text === 'no gate'
  );
  assert.equal(echoRan, true, 'the read-only call must not wait');
  assert.equal(
    mcpCalls.some(call => call.name === 'write_note'),
    false,
    'nothing side-effecting runs before the decision'
  );
  await workApprovalService.decide(task.id, pending[0].approvalId, userId, {
    approve: true,
    scope: 'once',
  });
  await execution;
  assert.equal(
    (await workTaskService.getRun(run.activeRun.id)).status,
    'completed'
  );
  assert.equal(
    mcpCalls.some(
      call => call.name === 'write_note' && call.args.text === 'gated'
    ),
    true
  );
});

test('servers missing a personal credential are filtered at offer time', async () => {
  const secured = await toolServers.registerToolServer(userId, {
    name: 'Secured MCP',
    kind: 'mcp',
    baseUrl: mcpUrl,
    authMode: 'bearer',
    accessMode: 'all-users',
  });

  providerScript.push((request, observer) => {
    const names = toolNames(request);
    assert.equal(
      names.some(name => name.startsWith('secured_mcp__')),
      false,
      'a credential-less server must not be offered to an autonomous run'
    );
    assert.ok(names.includes('notes_mcp__echo_note'));
    return textTurn('Checked.')(request, observer);
  });
  const first = await workTaskService.createTaskWithRun(
    userId,
    'Credential check',
    'test-model',
    true,
    provider
  );
  await workAgentService.execute(first.id, first.activeRun.id, userId);

  await toolServers.setToolServerCredential(userId, secured.id, 'token-123');
  providerScript.push(
    (request, observer) => {
      assert.ok(
        toolNames(request).includes('secured_mcp__echo_note'),
        'the credentialed server is offered'
      );
      return toolTurn('call-4', 'secured_mcp__echo_note', {
        text: 'secured',
      })(request, observer);
    },
    textTurn('Secured echo done.')
  );
  const second = await workTaskService.createRun(
    first.id,
    userId,
    'Use the secured server.'
  );
  await workAgentService.execute(first.id, second.activeRun.id, userId);
  const securedCall = mcpCalls.findLast(call => call.args.text === 'secured');
  assert.equal(securedCall.authorization, 'Bearer token-123');
});
