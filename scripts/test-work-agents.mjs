import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
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
const { WORK_AGENT_CLIS, parseWorkAgentModel } = await dist(
  'services/workAgentCatalog.js'
);
const { createWorkAgentStreamState, parseWorkAgentLine } = await dist(
  'services/workAgentStream.js'
);
const {
  ClaudeCodeHostLogin,
  CodexHostLogin,
  KiroHostLogin,
  OpenCodeHostLogin,
  PiHostLogin,
  WORK_AGENT_PROVIDER_HOSTS,
  placeholderFor,
} = await dist('services/workAgentHostLogins.js');
const { getWorkAgentAccess, setWorkAgentAccessMode, userHasWorkAgentAccess } =
  await dist('services/workAgentAccessService.js');
const { setWorkAccessMode } = await dist('services/workAccessService.js');
const { WorkAgentCliRunner } = await dist('services/workAgentCliRunner.js');
const {
  WorkEgressProxy,
  compileHostPatterns,
  createEgressPlaceholder,
  publicOnlyLookup,
} = await dist('services/workEgressProxy.js');
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

test("a login is only ever sent to its provider's exact API hosts", async () => {
  for (const [provider, hosts] of Object.entries(WORK_AGENT_PROVIDER_HOSTS)) {
    for (const host of hosts) {
      // Exact hosts: never a provider-wide domain someone else could host
      // content under.
      assert.ok(!host.includes('*'), `${provider} ${host}`);
    }
  }
  process.env.KIRO_API_KEY = 'ksk_server';
  try {
    const login = await new KiroHostLogin(() => '/nonexistent').prepare();
    // A wildcard in Kiro's hosts stands for a Region label only.
    const kiro = compileHostPatterns(login.credentials[0].hosts);
    assert.equal(kiro('runtime.us-east-1.kiro.dev'), true);
    assert.equal(kiro('management.eu-central-1.kiro.dev'), true);
    assert.equal(kiro('q.us-east-1.amazonaws.com'), true);
    assert.equal(kiro('attacker.execute-api.us-east-1.amazonaws.com'), false);
    assert.equal(kiro('app.kiro.dev'), false);
  } finally {
    delete process.env.KIRO_API_KEY;
  }
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
  // Pi's own default model for a provider, when only the provider is known.
  assert.deepEqual(WORK_AGENT_CLIS.pi.buildArgs('anthropic/').slice(-2), [
    '--provider',
    'anthropic',
  ]);
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

// --- Host logins: the CLI's own sign-in, carried into the sandbox as
// placeholders. Every fixture below holds a recognisable fake secret, and
// each test checks it never appears in what the sandbox receives.

const loginRoot = mkdtempSync(path.join(tmpdir(), 'libre-work-logins-'));
const sandboxBytes = login =>
  JSON.stringify(login.env) +
  login.files.map(file => file.content.toString('latin1')).join('\n');
const credentialSecret = item =>
  typeof item.secret === 'function' ? item.secret() : item.secret;

function memoryClaudeStore(initial) {
  const store = {
    value: initial,
    writes: 0,
    read: async () => store.value,
    write: async value => {
      store.value = value;
      store.writes += 1;
    },
  };
  return store;
}

test('Claude Code runs on the Claude login, refreshed and written back', async () => {
  const missing = new ClaudeCodeHostLogin(memoryClaudeStore(null));
  const status = await missing.status();
  assert.equal(status.ready, false);
  assert.match(status.reason, /not signed in on this server.*`claude`/);
  await assert.rejects(
    missing.prepare(),
    error => error.code === 'WORK_AGENT_NOT_SIGNED_IN'
  );

  const store = memoryClaudeStore({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-REAL-OLD',
      refreshToken: 'sk-ant-ort01-REAL-REFRESH',
      expiresAt: Date.now() + 60_000,
      scopes: ['user:inference'],
      subscriptionType: 'max',
    },
    other: 'kept',
  });
  const refreshed = [];
  const login = new ClaudeCodeHostLogin(store, async refreshToken => {
    refreshed.push(refreshToken);
    return {
      access: `sk-ant-oat01-REAL-NEW-${refreshed.length}`,
      refresh: `sk-ant-ort01-REAL-ROTATED-${refreshed.length}`,
      expiresAtMs: Date.now() + 8 * 60 * 60_000,
    };
  });
  assert.deepEqual(await login.status(), { ready: true });
  const prepared = await login.prepare(undefined);
  assert.deepEqual(refreshed, ['sk-ant-ort01-REAL-REFRESH']);
  // Written back where the CLI keeps it, other fields untouched.
  assert.equal(store.writes, 1);
  assert.equal(store.value.other, 'kept');
  assert.equal(store.value.claudeAiOauth.subscriptionType, 'max');
  assert.equal(
    store.value.claudeAiOauth.refreshToken,
    'sk-ant-ort01-REAL-ROTATED-1'
  );
  // The sandbox sees a placeholder as the CLI's headless subscription token.
  const placeholder = prepared.env.CLAUDE_CODE_OAUTH_TOKEN;
  assert.match(placeholder, /^lwui_ph_/);
  assert.doesNotMatch(sandboxBytes(prepared), /REAL/);
  assert.deepEqual(prepared.credentials[0].hosts, ['api.anthropic.com']);
  assert.equal(
    credentialSecret(prepared.credentials[0]),
    'sk-ant-oat01-REAL-NEW-1'
  );
  // A fresh login is not refreshed again; a long run picks up the next one.
  await prepared.refresh();
  assert.equal(refreshed.length, 1);
  store.value.claudeAiOauth.expiresAt = Date.now() + 1000;
  await prepared.refresh();
  assert.equal(refreshed.length, 2);
  assert.equal(
    credentialSecret(prepared.credentials[0]),
    'sk-ant-oat01-REAL-NEW-2'
  );

  // A failed refresh says what to do instead of running unauthenticated.
  store.value.claudeAiOauth.expiresAt = Date.now() + 1000;
  const failing = new ClaudeCodeHostLogin(store, async () => {
    throw new Error('invalid_grant');
  });
  await assert.rejects(failing.prepare(), /has expired.*`claude`/);

  // The server's own variables win, as they do for the CLI in Chat.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-REAL-ENV';
  try {
    const fromEnvironment = await new ClaudeCodeHostLogin(store).prepare();
    assert.match(fromEnvironment.env.ANTHROPIC_API_KEY, /^lwui_ph_/);
    assert.equal(
      credentialSecret(fromEnvironment.credentials[0]),
      'sk-ant-api-REAL-ENV'
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  try {
    const bedrock = new ClaudeCodeHostLogin(store);
    assert.match((await bedrock.status()).reason, /CLAUDE_CODE_USE_BEDROCK/);
  } finally {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
  }
});

const fakeJwt = claims =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.REALSIG`;

test('Codex runs on its ChatGPT login with a token-shaped placeholder', async () => {
  const home = path.join(loginRoot, 'codex');
  mkdirSync(home, { recursive: true });
  const none = new CodexHostLogin(() => home);
  assert.match((await none.status()).reason, /`codex login`/);

  const realAccess = fakeJwt({
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acct-1',
      chatgpt_plan_type: 'pro',
    },
    email: 'person@example.test',
  });
  writeFileSync(
    path.join(home, 'auth.json'),
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: fakeJwt({
          email: 'person@example.test',
          'https://api.openai.com/auth': {
            chatgpt_plan_type: 'pro',
            chatgpt_account_id: 'acct-1',
          },
        }),
        access_token: realAccess,
        refresh_token: 'rt-REAL',
        account_id: 'acct-1',
      },
    })
  );
  writeFileSync(
    path.join(home, 'config.toml'),
    'model = "gpt-6-sol"\n\n[profiles.x]\nmodel = "other"\n'
  );
  const asked = [];
  const login = new CodexHostLogin(() => home, {
    signIn: async margin => {
      asked.push(margin);
      return {
        accessToken: realAccess,
        accountId: 'acct-1',
        expiresAtMs: Date.now() + 3600_000,
      };
    },
  });
  assert.deepEqual(await login.status(), { ready: true });
  const prepared = await login.prepare(undefined);
  assert.ok(asked[0] > 0, 'asks for a token valid well into the run');
  assert.equal(prepared.model, 'gpt-6-sol');
  assert.doesNotMatch(sandboxBytes(prepared), /REAL|rt-REAL|person@example/);
  const auth = JSON.parse(prepared.files[0].content);
  assert.equal(prepared.files[0].path, '.codex/auth.json');
  assert.equal(auth.tokens.account_id, 'acct-1');
  // The placeholder still reads as a ChatGPT token for the same account.
  const claims = JSON.parse(
    Buffer.from(auth.tokens.access_token.split('.')[1], 'base64url')
  );
  assert.equal(
    claims['https://api.openai.com/auth'].chatgpt_account_id,
    'acct-1'
  );
  assert.ok(claims.exp * 1000 > Date.now() + 30 * 24 * 3600_000);
  const idClaims = JSON.parse(
    Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url')
  );
  assert.equal(
    idClaims['https://api.openai.com/auth'].chatgpt_plan_type,
    'pro'
  );
  assert.equal(prepared.credentials[0].placeholder, auth.tokens.access_token);
  assert.deepEqual(prepared.credentials[0].hosts, ['chatgpt.com']);
  assert.equal(credentialSecret(prepared.credentials[0]), realAccess);
  assert.match(placeholderFor('not-a-jwt'), /^lwui_ph_[0-9a-f]+$/);
});

function kiroDatabase(file, expiresAt) {
  const database = new Database(file);
  database.exec(`
    CREATE TABLE migrations (id INTEGER PRIMARY KEY, version INTEGER);
    CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE conversations (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO migrations (version) VALUES (7);
    INSERT INTO conversations VALUES ('/workspace', 'SECRET CHAT HISTORY');
    INSERT INTO state VALUES ('api.codewhisperer.profile', '{"arn":"arn:aws:codewhisperer:us-east-1:1:profile/P"}');
    INSERT INTO state VALUES ('auth.session.cookie', 'SECRET SESSION');
  `);
  database.prepare('INSERT INTO auth_kv VALUES (?, ?)').run(
    'kirocli:social:token',
    JSON.stringify({
      access_token: 'aoa-REAL-ACCESS',
      refresh_token: 'aor-REAL-REFRESH',
      expires_at: new Date(expiresAt).toISOString(),
      region: 'us-east-1',
    })
  );
  database
    .prepare('INSERT INTO auth_kv VALUES (?, ?)')
    .run(
      'kirocli:odic:device-registration',
      '{"client_secret":"REAL-CLIENT-SECRET"}'
    );
  database.close();
}

test('Kiro gets a scrubbed copy of its login database', async () => {
  const file = path.join(loginRoot, 'kiro.sqlite3');
  assert.match(
    (await new KiroHostLogin(() => file).status()).reason,
    /`kiro-cli login`/
  );
  kiroDatabase(file, Date.now() + 3600_000);
  let hostRefreshes = 0;
  const login = new KiroHostLogin(
    () => file,
    async () => {
      hostRefreshes += 1;
    }
  );
  assert.deepEqual(await login.status(), { ready: true });
  const prepared = await login.prepare(undefined);
  assert.equal(hostRefreshes, 0);
  assert.equal(prepared.files[0].path, '.local/share/kiro-cli/data.sqlite3');
  const bytes = prepared.files[0].content.toString('latin1');
  for (const secret of ['REAL', 'SECRET CHAT', 'SECRET SESSION']) {
    assert.ok(!bytes.includes(secret), `${secret} left in the sandbox copy`);
  }
  const copy = path.join(loginRoot, 'kiro-copy.sqlite3');
  writeFileSync(copy, prepared.files[0].content);
  const database = new Database(copy, { readonly: true });
  const token = JSON.parse(
    database
      .prepare("SELECT value FROM auth_kv WHERE key = 'kirocli:social:token'")
      .get().value
  );
  assert.equal(token.access_token, prepared.credentials[0].placeholder);
  assert.equal(token.region, 'us-east-1');
  assert.ok(Date.parse(token.expires_at) > Date.now() + 30 * 24 * 3600_000);
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM auth_kv').get().n,
    1
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM conversations').get().n,
    0
  );
  assert.equal(
    database.prepare('SELECT version FROM migrations').get().version,
    7
  );
  assert.ok(
    database
      .prepare("SELECT 1 FROM state WHERE key = 'api.codewhisperer.profile'")
      .get()
  );
  database.close();
  assert.equal(credentialSecret(prepared.credentials[0]), 'aoa-REAL-ACCESS');

  // Close to expiry, Kiro refreshes on the host first; if it cannot, the
  // run stops with what to do.
  const stale = path.join(loginRoot, 'kiro-stale.sqlite3');
  kiroDatabase(stale, Date.now() + 60_000);
  const refreshing = new KiroHostLogin(
    () => stale,
    async () => {
      const database = new Database(stale);
      database
        .prepare(
          "UPDATE auth_kv SET value = ? WHERE key = 'kirocli:social:token'"
        )
        .run(
          JSON.stringify({
            access_token: 'aoa-REAL-NEXT',
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
          })
        );
      database.close();
    }
  );
  const next = await refreshing.prepare(undefined);
  assert.equal(credentialSecret(next.credentials[0]), 'aoa-REAL-NEXT');
  kiroDatabase(path.join(loginRoot, 'kiro-dead.sqlite3'), Date.now() + 60_000);
  await assert.rejects(
    new KiroHostLogin(
      () => path.join(loginRoot, 'kiro-dead.sqlite3'),
      async () => undefined
    ).prepare(),
    /has expired.*`kiro-cli login`/
  );
});

test("OpenCode and Pi carry the chosen provider's login only", async () => {
  const authFile = path.join(loginRoot, 'opencode-auth.json');
  writeFileSync(
    authFile,
    JSON.stringify({
      openrouter: { type: 'api', key: 'sk-or-REAL' },
      anthropic: {
        type: 'oauth',
        access: 'sk-ant-oat-REAL-OLD',
        refresh: 'rt-REAL',
        expires: Date.now() - 1,
      },
      mystery: { type: 'api', key: 'REAL-MYSTERY' },
    })
  );
  const refreshed = [];
  const opencode = new OpenCodeHostLogin(() => authFile, {
    anthropic: async token => {
      refreshed.push(token);
      return {
        access: 'sk-ant-oat-REAL-NEW',
        refresh: 'rt-REAL-2',
        expiresAtMs: Date.now() + 3600_000,
      };
    },
  });
  const viaKey = await opencode.prepare('openrouter/openai/gpt-5-mini');
  assert.deepEqual(Object.keys(JSON.parse(viaKey.files[0].content)), [
    'openrouter',
  ]);
  assert.equal(viaKey.files[0].path, '.local/share/opencode/auth.json');
  assert.deepEqual(viaKey.credentials[0].hosts, ['openrouter.ai']);
  assert.doesNotMatch(sandboxBytes(viaKey), /REAL/);

  const viaOauth = await opencode.prepare('anthropic/claude-sonnet-5-5');
  assert.deepEqual(refreshed, ['rt-REAL']);
  const entry = JSON.parse(viaOauth.files[0].content).anthropic;
  assert.equal(entry.type, 'oauth');
  assert.equal(entry.access, viaOauth.credentials[0].placeholder);
  assert.ok(entry.expires > Date.now() + 30 * 24 * 3600_000);
  assert.doesNotMatch(sandboxBytes(viaOauth), /REAL/);
  assert.equal(
    credentialSecret(viaOauth.credentials[0]),
    'sk-ant-oat-REAL-NEW'
  );
  // Written back for the CLI on the host, other logins untouched.
  const saved = JSON.parse(readFileSync(authFile, 'utf8'));
  assert.equal(saved.anthropic.refresh, 'rt-REAL-2');
  assert.equal(saved.openrouter.key, 'sk-or-REAL');

  await assert.rejects(
    opencode.prepare('mystery/model'),
    /does not know which API hosts/
  );
  await assert.rejects(
    opencode.prepare('groq/llama'),
    /no login for "groq".*`opencode auth login`/
  );

  const piDir = path.join(loginRoot, 'pi');
  mkdirSync(piDir, { recursive: true });
  writeFileSync(
    path.join(piDir, 'auth.json'),
    JSON.stringify({ anthropic: { type: 'api_key', key: 'sk-ant-REAL' } })
  );
  writeFileSync(
    path.join(piDir, 'settings.json'),
    JSON.stringify({
      defaultProvider: 'anthropic',
      defaultModel: 'claude-sonnet-5-5',
      theme: 'dark',
    })
  );
  const pi = await new PiHostLogin(() => piDir).prepare(undefined);
  assert.equal(pi.model, 'anthropic/claude-sonnet-5-5');
  assert.deepEqual(
    pi.files.map(file => file.path),
    ['.pi/agent/auth.json', '.pi/agent/settings.json']
  );
  assert.deepEqual(JSON.parse(pi.files[1].content), {
    defaultProvider: 'anthropic',
    defaultModel: 'claude-sonnet-5-5',
  });
  assert.doesNotMatch(sandboxBytes(pi), /REAL/);
  assert.equal(credentialSecret(pi.credentials[0]), 'sk-ant-REAL');
  const emptyPi = path.join(loginRoot, 'pi-empty');
  mkdirSync(emptyPi, { recursive: true });
  assert.match(
    (await new PiHostLogin(() => emptyPi).status()).reason ?? 'ready',
    /ready|`pi`/
  );
});

test.after(() => rmSync(loginRoot, { recursive: true, force: true }));

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
    const args = command.map(value =>
      value === '/opt/libre-agents/node/current/bin/node'
        ? process.execPath
        : mapPath(value)
    );
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
  login: {
    status: async () => ({ ready: true }),
    prepare: async () => {
      const placeholder = createEgressPlaceholder();
      return {
        credentials: [
          {
            name: 'KIRO_API_KEY',
            placeholder,
            secret: () => 'ksk_real',
            hosts: ['runtime.*.example.test'],
          },
        ],
        env: { KIRO_API_KEY: placeholder },
        files: [
          {
            path: '.kiro-test/login.json',
            content: Buffer.from(JSON.stringify({ token: placeholder })),
          },
        ],
      };
    },
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
    // The login file landed in the agent home, owner-only, placeholder only.
    const loginFile = path.join(
      sandboxRoot,
      'home',
      '.kiro-test',
      'login.json'
    );
    assert.match(readFileSync(loginFile, 'utf8'), /lwui_ph_/);
    assert.equal(statSync(loginFile).mode & 0o777, 0o600);
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
