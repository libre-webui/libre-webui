import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-agents-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

await dist('db.js');
const {
  WORK_AGENT_CLIS,
  WORK_AGENT_CLI_IDS,
  parseWorkAgentModel,
  workAgentCredentialSlots,
  workAgentModelFamily,
} = await dist('services/workAgentCatalog.js');
const { createWorkAgentStreamState, parseWorkAgentLine } = await dist(
  'services/workAgentStream.js'
);
const { WorkAgentCredentialService } = await dist(
  'services/workAgentCredentialService.js'
);
const { getWorkAgentAccess, setWorkAgentAccessMode, userHasWorkAgentAccess } =
  await dist('services/workAgentAccessService.js');
const { setWorkAccessMode } = await dist('services/workAccessService.js');
const { WorkAgentCliRunner } = await dist('services/workAgentCliRunner.js');
const { WorkEgressProxy, compileHostPatterns, publicOnlyLookup } = await dist(
  'services/workEgressProxy.js'
);
const { createCertificateAuthority, issueServerCertificate } =
  await dist('utils/x509.js');
const { buildWorkAgentCliPrompt } = await dist('services/workAgentService.js');
const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);

const scratch = mkdtempSync(path.join(tmpdir(), 'libre-work-agents-run-'));

test.after(async () => {
  await closeWorkPlatform();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const parseAll = (cli, lines) => {
  const state = createWorkAgentStreamState();
  const events = lines.flatMap(line =>
    parseWorkAgentLine(cli, JSON.stringify(line), state)
  );
  return { events, state };
};

test('every agent CLI keys only its own exact service hosts', () => {
  for (const id of WORK_AGENT_CLI_IDS) {
    const cli = WORK_AGENT_CLIS[id];
    assert.ok(cli.credentials.length > 0, `${id} needs a credential slot`);
    for (const slot of cli.credentials) {
      assert.match(slot.env, /^[A-Z][A-Z0-9_]+$/);
      for (const host of slot.hosts) {
        // A wildcard may stand for a Region label, never for a whole
        // provider domain someone else could host content under.
        assert.ok(!host.startsWith('*.'), `${id} ${slot.env} ${host}`);
        assert.doesNotMatch(host, /^\*|\.\*$/);
      }
    }
  }
  const kiro = compileHostPatterns(WORK_AGENT_CLIS.kiro.credentials[0].hosts);
  assert.equal(kiro('runtime.us-east-1.kiro.dev'), true);
  assert.equal(kiro('management.eu-central-1.kiro.dev'), true);
  assert.equal(kiro('q.us-east-1.amazonaws.com'), true);
  assert.equal(kiro('attacker.execute-api.us-east-1.amazonaws.com'), false);
  assert.equal(kiro('app.kiro.dev'), false);
  const bedrock = compileHostPatterns(
    WORK_AGENT_CLIS['claude-code'].credentials.find(
      slot => slot.env === 'AWS_BEARER_TOKEN_BEDROCK'
    ).hosts
  );
  assert.equal(bedrock('bedrock-runtime.us-east-1.amazonaws.com'), true);
  assert.equal(bedrock('bucket.s3.us-east-1.amazonaws.com'), false);
});

test('agent CLIs run non-interactively with their tools approved in the sandbox', () => {
  const claude = WORK_AGENT_CLIS['claude-code'].buildArgs('claude-haiku-5-5');
  assert.ok(claude.includes('--dangerously-skip-permissions'));
  assert.deepEqual(claude.slice(-2), ['--model', 'claude-haiku-5-5']);
  assert.ok(
    WORK_AGENT_CLIS.codex
      .buildArgs()
      .includes('--dangerously-bypass-approvals-and-sandbox')
  );
  const kiro = WORK_AGENT_CLIS.kiro.buildArgs();
  assert.ok(kiro.includes('--trust-all-tools'));
  assert.deepEqual(
    kiro.slice(kiro.indexOf('--agent'), kiro.indexOf('--agent') + 2),
    ['--agent', 'vibe']
  );
  assert.deepEqual(
    WORK_AGENT_CLIS.pi
      .buildArgs('openrouter/anthropic/claude-haiku-4.5')
      .slice(-4),
    ['--provider', 'openrouter', '--model', 'anthropic/claude-haiku-4.5']
  );
  assert.deepEqual(
    WORK_AGENT_CLIS.opencode
      .buildArgs('openrouter/openai/gpt-5-mini')
      .slice(-2),
    ['-m', 'openrouter/openai/gpt-5-mini']
  );
  assert.equal(parseWorkAgentModel('kiro', 'kiro'), undefined);
  assert.equal(
    parseWorkAgentModel('kiro', 'kiro:claude-sonnet-4.6'),
    'claude-sonnet-4.6'
  );
  assert.equal(parseWorkAgentModel('kiro', 'codex:gpt'), undefined);
  assert.equal(workAgentModelFamily('openrouter/x/y'), 'openrouter');
  assert.equal(workAgentModelFamily('google/gemini'), undefined);
  assert.deepEqual(
    workAgentCredentialSlots(
      WORK_AGENT_CLIS.pi,
      'anthropic/claude-haiku-4.5'
    ).map(slot => slot.env),
    ['ANTHROPIC_API_KEY']
  );
});

test('Claude Code streams text, tools, and its final result', () => {
  const { events } = parseAll('claude-code', [
    { type: 'system', subtype: 'init', session_id: 's1' },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'plan' },
      },
    },
    {
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Writing ' },
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Writing ' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'Write',
            input: { file_path: 'a.txt' },
          },
        ],
      },
    },
    {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [{ type: 'text', text: 'ok' }],
          },
        ],
      },
    },
    { type: 'result', subtype: 'success', is_error: false, result: 'Done.' },
  ]);
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'plan' },
    { type: 'text', text: 'Writing ' },
    {
      type: 'tool_start',
      id: 'toolu_1',
      name: 'Write',
      input: { file_path: 'a.txt' },
    },
    {
      type: 'tool_end',
      id: 'toolu_1',
      name: 'Write',
      output: 'ok',
      isError: false,
    },
    { type: 'final', text: 'Done.' },
  ]);
  const failed = parseAll('claude-code', [
    { type: 'result', subtype: 'error_during_execution', is_error: true },
  ]);
  assert.deepEqual(failed.events, [
    { type: 'failure', message: 'error_during_execution' },
  ]);
});

test('Codex items become tool activity, messages, and failures', () => {
  const { events, state } = parseAll('codex', [
    { type: 'thread.started', thread_id: 't1' },
    {
      type: 'item.started',
      item: {
        id: 'i1',
        type: 'command_execution',
        command: 'npm test',
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'i1',
        type: 'command_execution',
        command: 'npm test',
        aggregated_output: 'fail',
        exit_code: 1,
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: { id: 'i2', type: 'agent_message', text: 'Tests fail.' },
    },
    { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  ]);
  assert.deepEqual(events, [
    {
      type: 'tool_start',
      id: 'i1',
      name: 'shell',
      input: { command: 'npm test' },
    },
    {
      type: 'tool_end',
      id: 'i1',
      name: 'shell',
      output: 'fail',
      isError: true,
    },
    { type: 'text', text: 'Tests fail.' },
  ]);
  assert.equal(state.trailingText, 'Tests fail.');
  assert.ok(state.usage);
  const failed = parseAll('codex', [
    { type: 'turn.failed', error: { message: 'quota exceeded' } },
  ]);
  assert.deepEqual(failed.events, [
    { type: 'failure', message: 'quota exceeded' },
  ]);
});

test('Kiro session updates map onto Work tool activity', () => {
  const { events } = parseAll('kiro', [
    { type: 'runStarted', data: { engine: 'v3' } },
    {
      type: 'sessionUpdate',
      data: {
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'hm' },
        },
      },
    },
    {
      type: 'sessionUpdate',
      data: {
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'k1',
          title: 'Write hello.txt',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: 'hello.txt' },
        },
      },
    },
    {
      type: 'sessionUpdate',
      data: {
        sessionId: 's',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'k1',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: 'written' } },
          ],
        },
      },
    },
    {
      type: 'sessionUpdate',
      data: {
        sessionId: 's',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Done' },
        },
      },
    },
    { type: 'runFinished', data: { status: 'success', finalText: 'Done' } },
  ]);
  assert.deepEqual(events, [
    { type: 'reasoning', text: 'hm' },
    {
      type: 'tool_start',
      id: 'k1',
      name: 'Write hello.txt',
      input: { path: 'hello.txt' },
    },
    {
      type: 'tool_end',
      id: 'k1',
      name: 'Write hello.txt',
      output: 'written',
      isError: false,
    },
    { type: 'text', text: 'Done' },
    { type: 'final', text: 'Done' },
  ]);
  assert.deepEqual(
    parseAll('kiro', [{ type: 'runError', data: { message: 'bad key' } }])
      .events,
    [{ type: 'failure', message: 'Kiro failed: bad key' }]
  );
});

test('OpenCode and Pi report tools, text, and provider errors', () => {
  const opencode = parseAll('opencode', [
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        callID: 'c1',
        tool: 'write',
        state: { status: 'running', input: { filePath: 'a' } },
      },
    },
    {
      type: 'tool_use',
      part: {
        type: 'tool',
        callID: 'c1',
        tool: 'write',
        state: {
          status: 'completed',
          input: { filePath: 'a' },
          output: 'Wrote file successfully.',
        },
      },
    },
    { type: 'text', part: { id: 'p1', type: 'text', text: 'Created it.' } },
    { type: 'text', part: { id: 'p1', type: 'text', text: 'Created it.' } },
  ]);
  assert.deepEqual(opencode.events, [
    { type: 'tool_start', id: 'c1', name: 'write', input: { filePath: 'a' } },
    {
      type: 'tool_end',
      id: 'c1',
      name: 'write',
      output: 'Wrote file successfully.',
      isError: false,
    },
    { type: 'text', text: 'Created it.' },
  ]);
  assert.deepEqual(
    parseAll('opencode', [
      {
        type: 'error',
        error: { name: 'APIError', data: { message: 'User not found.' } },
      },
    ]).events,
    [{ type: 'failure', message: 'User not found.' }]
  );
  const pi = parseAll('pi', [
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hi' },
    },
    {
      type: 'tool_execution_start',
      toolCallId: 'p1',
      toolName: 'bash',
      args: { command: 'ls' },
    },
    {
      type: 'tool_execution_end',
      toolCallId: 'p1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'a.txt' }] },
      isError: false,
    },
    {
      type: 'message_end',
      message: {
        role: 'assistant',
        stopReason: 'error',
        errorMessage: '401 Missing Authentication header',
      },
    },
  ]);
  assert.deepEqual(pi.events, [
    { type: 'text', text: 'Hi' },
    { type: 'tool_start', id: 'p1', name: 'bash', input: { command: 'ls' } },
    {
      type: 'tool_end',
      id: 'p1',
      name: 'bash',
      output: 'a.txt',
      isError: false,
    },
    { type: 'failure', message: '401 Missing Authentication header' },
  ]);
  assert.deepEqual(
    parseWorkAgentLine('pi', 'not json', createWorkAgentStreamState()),
    []
  );
});

test('agent credentials resolve stored, then environment, then provider keys', async () => {
  const providers = {
    calls: [],
    apiKey: async (pluginId, userId) => {
      providers.calls.push([pluginId, userId]);
      return pluginId === 'openrouter'
        ? 'sk-or-user'
        : pluginId === 'bedrock'
          ? 'bedrock-user'
          : null;
    },
    variables: async pluginId =>
      pluginId === 'bedrock' ? { region: 'eu-west-2' } : {},
  };
  const service = new WorkAgentCredentialService(providers);
  const kiro = WORK_AGENT_CLIS.kiro;
  assert.equal(await service.resolve(kiro, undefined, 'user-1'), null);
  process.env.WORK_AGENT_KIRO_API_KEY = 'ksk_environment';
  try {
    const fromEnvironment = await service.resolve(kiro, undefined, 'user-1');
    assert.equal(fromEnvironment.secret, 'ksk_environment');
    assert.equal(fromEnvironment.origin, 'environment');
    await service.set('KIRO_API_KEY', '  ksk_saved  ');
    const saved = await service.resolve(kiro, undefined, 'user-1');
    assert.equal(saved.secret, 'ksk_saved');
    assert.equal(saved.origin, 'stored');
    const view = (await service.list()).find(
      item => item.name === 'KIRO_API_KEY'
    );
    assert.equal(view.configured, true);
    assert.equal(view.source, 'stored');
    assert.deepEqual(view.usedBy, ['kiro']);
    assert.ok(!JSON.stringify(await service.list()).includes('ksk_saved'));
    await service.set('KIRO_API_KEY', '');
    assert.equal(
      (await service.resolve(kiro, undefined, 'user-1')).origin,
      'environment'
    );
  } finally {
    delete process.env.WORK_AGENT_KIRO_API_KEY;
  }
  // The server's own variable is never picked up implicitly.
  process.env.KIRO_API_KEY = 'ksk_server_owned';
  try {
    assert.equal(await service.resolve(kiro, undefined, 'user-1'), null);
  } finally {
    delete process.env.KIRO_API_KEY;
  }

  const fromProvider = await service.resolve(
    WORK_AGENT_CLIS.opencode,
    'openrouter/openai/gpt-5-mini',
    'user-2'
  );
  assert.equal(fromProvider.secret, 'sk-or-user');
  assert.equal(fromProvider.origin, 'provider');
  assert.equal(fromProvider.slot.env, 'OPENROUTER_API_KEY');
  assert.deepEqual(providers.calls.at(-1), ['openrouter', 'user-2']);

  const bedrock = await service.resolve(
    WORK_AGENT_CLIS['claude-code'],
    'haiku',
    'user-3'
  );
  assert.equal(bedrock.slot.env, 'AWS_BEARER_TOKEN_BEDROCK');
  assert.deepEqual(bedrock.env, {
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: 'eu-west-2',
  });

  await assert.rejects(service.set('PATH', 'x'), /Unknown agent credential/);
  await assert.rejects(service.set('KIRO_API_KEY', 'two words'), /whitespace/);
});

test('agent CLIs in Work start disabled and need Work access too', async () => {
  delete process.env.LIBRE_WORK_AGENTS_ACCESS;
  assert.deepEqual(await getWorkAgentAccess(), {
    mode: 'disabled',
    lockedByEnv: false,
  });
  const admin = { id: 'admin-1', role: 'admin', status: 'active' };
  const member = { id: 'user-1', role: 'user', status: 'active' };
  assert.equal(
    await userHasWorkAgentAccess(admin),
    false,
    'disabled means admins too'
  );
  await setWorkAgentAccessMode('admins');
  assert.equal(await userHasWorkAgentAccess(admin), true);
  assert.equal(await userHasWorkAgentAccess(member), false);
  await setWorkAgentAccessMode('all-users');
  await setWorkAccessMode('admins');
  assert.equal(
    await userHasWorkAgentAccess(member),
    false,
    'Work itself is admin-only'
  );
  await setWorkAccessMode('all-users');
  assert.equal(await userHasWorkAgentAccess(member), true);
  assert.equal(
    await userHasWorkAgentAccess({ ...member, status: 'disabled' }),
    false
  );
  process.env.LIBRE_WORK_AGENTS_ACCESS = 'nonsense';
  try {
    assert.deepEqual(await getWorkAgentAccess(), {
      mode: 'disabled',
      lockedByEnv: true,
    });
    await assert.rejects(setWorkAgentAccessMode('admins'), /pinned/);
  } finally {
    delete process.env.LIBRE_WORK_AGENTS_ACCESS;
  }
  await setWorkAgentAccessMode('disabled');
  await setWorkAccessMode('admins');
});

test('the agent prompt carries the task conversation and the persona', () => {
  const message = (role, content, runId, extra = {}) => ({
    id: `${role}-${content}`,
    taskId: 't',
    runId,
    messageIndex: 0,
    role,
    kind: 'message',
    content,
    createdAt: 0,
    ...extra,
  });
  const messages = [
    message('user', 'Build a site', 'r1'),
    message('assistant', 'Built index.html', 'r1'),
    message('assistant', 'placeholder', 'r1', {
      metadata: { emptyModelResponse: true },
    }),
    message('user', 'Add a footer', 'r2'),
  ];
  const prompt = buildWorkAgentCliPrompt(messages, 'r2', {
    name: 'Libra',
    instructions: 'Be terse.',
  });
  assert.match(prompt, /^You are working as Libra\.\n\nBe terse\./);
  assert.match(prompt, /User: Build a site\n\nAssistant: Built index\.html/);
  assert.doesNotMatch(prompt, /placeholder/);
  assert.match(prompt, /The new request:\n\nAdd a footer$/);
  assert.equal(
    buildWorkAgentCliPrompt(messages.slice(0, 1), 'r1'),
    'Build a site'
  );
});

// --- Runner integration: the real relay, proxy, and supervisor against a
// local fake sandbox, with a fake Kiro-format CLI calling a fake upstream.

const SANDBOX_DIR = '/tmp/libre-agent';
const sandboxRoot = path.join(scratch, 'sandbox');
const workspace = path.join(scratch, 'workspace');
mkdirSync(sandboxRoot, { recursive: true });
mkdirSync(workspace, { recursive: true });

const mapPath = value =>
  typeof value === 'string'
    ? value.split(SANDBOX_DIR).join(sandboxRoot)
    : value;

const fakeCli = path.join(scratch, 'fake-kiro.mjs');
writeFileSync(
  fakeCli,
  `#!${process.execPath}
import fs from 'node:fs';
import http from 'node:http';
import tls from 'node:tls';
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const prompt = fs.readFileSync(0, 'utf8');
if (prompt.includes('HANG')) setInterval(() => {}, 1000);
else if (prompt.includes('CRASH')) { process.stderr.write('boom: invalid key\\n'); process.exit(3); }
else {
  emit({ type: 'runStarted', data: { engine: 'v3' } });
  emit({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write note.txt', status: 'pending' } } });
  fs.writeFileSync('note.txt', prompt);
  const proxy = new URL(process.env.HTTPS_PROXY);
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: 'runtime.us-east-1.example.test:443' });
    request.on('connect', (_response, socket) => {
      const secure = tls.connect({ socket, servername: 'runtime.us-east-1.example.test', ca: [fs.readFileSync(process.env.NODE_EXTRA_CA_CERTS)] }, () => {
        secure.write('GET /generate HTTP/1.1\\r\\nHost: runtime.us-east-1.example.test\\r\\nAuthorization: Bearer ' + process.env.KIRO_API_KEY + '\\r\\nConnection: close\\r\\n\\r\\n');
      });
      let body = '';
      secure.on('data', data => (body += data));
      secure.on('end', () => resolve(body.split('\\r\\n')[0]));
      secure.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
  emit({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: status } }] } } });
  emit({ type: 'sessionUpdate', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Saved the note.' } } } });
  emit({ type: 'runFinished', data: { status: 'success', finalText: 'Saved the note.' } });
}
`
);
chmodSync(fakeCli, 0o755);

/** Runs "sandbox" commands as local processes under the scratch root. */
const fakeDriver = {
  async exec(_task, command, options = {}) {
    const args = command.map(mapPath);
    return new Promise((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), { cwd: workspace });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', data => (stdout += data));
      child.stderr.on('data', data => (stderr += data));
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0 && !options.acceptFailure) {
          reject(new Error(stderr || `exit ${code}`));
          return;
        }
        resolve({ exitCode: code ?? -1, stdout, stderr, truncated: false });
      });
      child.stdin.end(options.input ?? '');
    });
  },
  async openProcess(_task, command, options = {}) {
    const args = command.map(value =>
      value === '/opt/libre-agents/node/current/bin/node'
        ? process.execPath
        : value.startsWith('/opt/libre-agents/cli/')
          ? fakeCli
          : mapPath(value)
    );
    const env = { ...process.env };
    for (const [name, value] of Object.entries(options.env ?? {})) {
      if (name !== 'PATH' && name !== 'HOME') env[name] = mapPath(value);
    }
    const child = spawn(args[0], args.slice(1), {
      cwd: options.workdir === '/workspace' ? workspace : sandboxRoot,
      env,
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      exited: new Promise(resolve => child.on('close', code => resolve(code))),
      kill: () => child.kill('SIGKILL'),
    };
  },
};

async function startUpstream() {
  const authority = createCertificateAuthority('Runner test upstream');
  const certificate = issueServerCertificate(
    authority,
    'runtime.us-east-1.example.test'
  );
  const seen = [];
  const server = https.createServer(
    { key: certificate.privateKeyPem, cert: certificate.certificatePem },
    (request, response) => {
      seen.push(request.headers.authorization);
      response.writeHead(
        request.headers.authorization === 'Bearer ksk_real' ? 200 : 401
      );
      response.end();
    }
  );
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { authority, port: server.address().port, seen, server };
}

function runnerFor(upstream) {
  return new WorkAgentCliRunner({
    driver: () => fakeDriver,
    proxy: new WorkEgressProxy({
      lookup: (hostname, options, callback) =>
        hostname.endsWith('.example.test')
          ? options.all
            ? callback(null, [{ address: '127.0.0.1', family: 4 }])
            : callback(null, '127.0.0.1', 4)
          : publicOnlyLookup(hostname, options, callback),
      upstreamCa: [upstream.authority.certificatePem],
      upstreamPort: () => upstream.port,
    }),
    toolchain: {
      isCurrent: () => true,
      ensureInstalled: async () => undefined,
      unavailableReason: () => null,
    },
  });
}

function recordingSink() {
  const calls = [];
  return {
    calls,
    sink: {
      phase: async phase => calls.push(['phase', phase]),
      text: delta => calls.push(['text', delta]),
      reasoning: delta => calls.push(['reasoning', delta]),
      toolStart: async call => calls.push(['toolStart', call.id, call.name]),
      toolEnd: async result =>
        calls.push(['toolEnd', result.id, result.output, result.isError]),
      usage: () => undefined,
    },
  };
}

const kiroRequest = (prompt, signal) => ({
  task: {
    id: 'task-1',
    containerName: 'c',
    volumeName: 'v',
    networkEnabled: false,
  },
  runId: `run-${Math.random().toString(36).slice(2)}`,
  cli: WORK_AGENT_CLIS.kiro,
  model: undefined,
  credential: {
    slot: { env: 'KIRO_API_KEY', hosts: ['runtime.*.example.test'] },
    secret: 'ksk_real',
    env: {},
    origin: 'stored',
  },
  prompt,
  signal,
});

test('a sandboxed agent run reaches its API only through the injecting proxy', async () => {
  const upstream = await startUpstream();
  try {
    const { calls, sink } = recordingSink();
    const result = await runnerFor(upstream).run(
      kiroRequest('Write the note', new AbortController().signal),
      sink
    );
    assert.equal(result.finalText, 'Saved the note.');
    assert.deepEqual(result.changedFiles, ['note.txt']);
    assert.equal(
      readFileSync(path.join(workspace, 'note.txt'), 'utf8'),
      'Write the note'
    );
    assert.deepEqual(upstream.seen, ['Bearer ksk_real']);
    assert.deepEqual(
      calls.filter(call => call[0] !== 'text'),
      [
        ['phase', 'starting'],
        ['phase', 'running'],
        ['toolStart', 't1', 'Write note.txt'],
        ['toolEnd', 't1', 'HTTP/1.1 200 OK', false],
      ]
    );
    // The sandbox only ever held the placeholder and the public certificate.
    const certificate = readFileSync(path.join(sandboxRoot, 'ca.pem'), 'utf8');
    assert.match(certificate, /BEGIN CERTIFICATE/);
    assert.ok(!existsSync(path.join(sandboxRoot, 'ksk_real')));
  } finally {
    upstream.server.closeAllConnections();
    upstream.server.close();
  }
});

test('a failing agent reports its error and a hanging one is stopped', async () => {
  const upstream = await startUpstream();
  try {
    await assert.rejects(
      runnerFor(upstream).run(
        kiroRequest('CRASH', new AbortController().signal),
        recordingSink().sink
      ),
      error =>
        error.code === 'WORK_AGENT_FAILED' &&
        /boom: invalid key/.test(error.message)
    );
    const controller = new AbortController();
    const request = kiroRequest('HANG', controller.signal);
    const pidFile = path.join(sandboxRoot, `run-${request.runId}.pid`);
    const running = runnerFor(upstream).run(request, recordingSink().sink);
    let group;
    for (let attempt = 0; attempt < 100 && !group; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 50));
      if (existsSync(pidFile)) group = Number(readFileSync(pidFile, 'utf8'));
    }
    assert.ok(group > 0, 'the supervisor records the agent process group');
    controller.abort(new Error('cancelled by test'));
    await assert.rejects(running, /cancelled by test/);
    // The whole group is gone: the CLI and anything it started.
    const alive = () => {
      try {
        process.kill(-group, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let attempt = 0; attempt < 50 && alive(); attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(alive(), false);
  } finally {
    upstream.server.closeAllConnections();
    upstream.server.close();
  }
});
