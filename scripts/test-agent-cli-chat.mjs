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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Agents are disabled by default; these tests exercise the persisted
// admin opt-in against a throwaway database.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-agent-cli-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
// This suite tests CLI model lists independently of host engine settings.
process.env.LIBRE_CORDIS_ENABLED = 'false';
delete process.env.AGENT_CLI_MODELS_ENABLED;

const distUrl = name =>
  pathToFileURL(path.join(__dirname, '..', 'backend', 'dist', name)).href;
const serviceUrl = distUrl(path.join('services', 'agentCliService.js'));

const {
  AGENT_CLI_DEFINITIONS,
  parseOpencodeLine,
  parsePiLine,
  parseClaudeLine,
  parseCodexLine,
  default: agentCliService,
} = await import(serviceUrl);
const { agentCliTokenUsage } = await import(
  distUrl('services/agentCliUsage.js')
);
const {
  getAgentCliModelsEnabled,
  setAgentCliModelsEnabled,
  agentCliModelsEnabledLockedByEnv,
} = await import(distUrl(path.join('services', 'agentAccessService.js')));
const { closeDatabase } = await import(distUrl('db.js'));

// The feature ships disabled; opt in for the tests that list models.
assert.equal(await getAgentCliModelsEnabled(), false);
await setAgentCliModelsEnabled(true);

after(() => {
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const collect = () => {
  const chunks = [];
  return {
    chunks,
    queue: { push: chunk => chunks.push(chunk) },
    state: { emittedContent: false, itemErrors: [], partTextLengths: {} },
  };
};

const definition = id =>
  AGENT_CLI_DEFINITIONS.find(candidate => candidate.id === id);

test('every agent CLI passes an explicit model through to its argv', () => {
  assert.deepEqual(definition('claude-code').buildArgs('opus').slice(-2), [
    '--model',
    'opus',
  ]);
  assert.deepEqual(definition('codex').buildArgs('gpt-5.4').slice(-3), [
    '-m',
    'gpt-5.4',
    '-',
  ]);
  assert.deepEqual(
    definition('opencode').buildArgs('openai/gpt-5.4').slice(-2),
    ['-m', 'openai/gpt-5.4']
  );
  assert.deepEqual(definition('pi').buildArgs('provider/model').slice(-2), [
    '--model',
    'provider/model',
  ]);
});

test('Codex lists Astra and GPT-5.5 alongside the bundled ChatGPT model family', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-model-list-'));
  const binary = path.join(binDir, 'codex');
  // Listing fixed Codex choices only checks the binary; it must not run it.
  fs.writeFileSync(binary, '');
  fs.chmodSync(binary, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const models = await agentCliService.listAgentModels();
    const plugin = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '..', 'plugins', 'codex-oauth.json'),
        'utf8'
      )
    );
    assert.deepEqual(
      models.map(model => model.id),
      ['codex', ...plugin.model_map.map(model => `codex:${model}`)]
    );
    assert.equal(
      models.find(model => model.id === 'codex:gpt-6-astra')?.name,
      'Codex · GPT-6 Astra'
    );
    assert.equal(
      models.find(model => model.id === 'codex:gpt-5.5')?.name,
      'Codex · GPT-5.5'
    );
    assert.deepEqual(definition('codex').buildArgs('gpt-6-astra').slice(-3), [
      '-m',
      'gpt-6-astra',
      '-',
    ]);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('pi runs stateless, tool-less, with a neutral system prompt', () => {
  const args = definition('pi').buildArgs();
  assert.ok(
    args.includes('--no-session'),
    'must not touch the server user session store'
  );
  assert.ok(
    args.includes('--no-tools'),
    'chat replies must not run local tools'
  );
  const promptIndex = args.indexOf('--system-prompt');
  assert.ok(promptIndex !== -1, 'personal persona config must be overridden');
  assert.match(args[promptIndex + 1], /helpful assistant/);
});

test('opencode requires an explicit model', () => {
  assert.equal(definition('opencode').requiresModel, true);
});

test('pi parser streams text deltas and falls back to the final message', () => {
  const { chunks, queue, state } = collect();
  const lines = [
    '{"type":"session","version":3,"id":"sess-1","timestamp":"t","cwd":"/"}',
    '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"delta":"hm"}}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"po"}}',
    '{"type":"message_update","assistantMessageEvent":{"type":"text_delta","contentIndex":1,"delta":"ng"}}',
  ];
  for (const line of lines) parsePiLine(line, queue, state);
  assert.equal(state.agentSessionId, 'sess-1');
  assert.deepEqual(
    chunks
      .filter(chunk => chunk.type === 'content')
      .map(chunk => chunk.content),
    ['po', 'ng']
  );
  assert.deepEqual(
    chunks
      .filter(chunk => chunk.type === 'reasoning')
      .map(chunk => chunk.content),
    ['hm']
  );

  // A run without deltas still yields the final text from turn_end.
  const fallback = collect();
  parsePiLine(
    '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"x"},{"type":"text","text":"pong"}]}}',
    fallback.queue,
    fallback.state
  );
  assert.deepEqual(fallback.chunks, [{ type: 'content', content: 'pong' }]);
});

test('opencode parser emits completed parts once and surfaces error events', () => {
  const { chunks, queue, state } = collect();
  const textEvent =
    '{"type":"text","timestamp":1,"sessionID":"ses_1","part":{"id":"prt_1","messageID":"msg_1","sessionID":"ses_1","type":"text","text":"pong","time":{"start":1,"end":2}}}';
  parseOpencodeLine(
    '{"type":"step_start","timestamp":1,"sessionID":"ses_1","part":{"id":"prt_0","type":"step-start"}}',
    queue,
    state
  );
  parseOpencodeLine(textEvent, queue, state);
  parseOpencodeLine(textEvent, queue, state); // duplicate part must not double-emit
  assert.equal(state.agentSessionId, 'ses_1');
  assert.deepEqual(chunks, [{ type: 'content', content: 'pong' }]);

  const failed = collect();
  parseOpencodeLine(
    '{"type":"error","timestamp":1,"error":{"name":"ProviderAuthError","data":{"providerID":"openai","message":"Token refresh failed: 401"}}}',
    failed.queue,
    failed.state
  );
  assert.deepEqual(failed.state.itemErrors, ['Token refresh failed: 401']);
  assert.equal(failed.state.emittedContent, false);
});

test('claude parser still handles partial stream events', () => {
  const { chunks, queue, state } = collect();
  parseClaudeLine(
    '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"pong"}}}',
    queue,
    state
  );
  assert.deepEqual(chunks, [{ type: 'content', content: 'pong' }]);
});

test('listAgentModels expands CLIs into per-model entries with a shared agentId', async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cli-test-'));
  const fakeCli = (name, body) => {
    const file = path.join(binDir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };
  fakeCli('claude', 'exit 0');
  fakeCli(
    'opencode',
    [
      'if [ "$1" = "models" ]; then',
      '  echo "opencode/big-pickle"',
      '  echo "openai/gpt-5.4"',
      '  echo "not a model line"',
      'fi',
    ].join('\n')
  );

  const previousPath = process.env.PATH;
  process.env.PATH = binDir;
  try {
    const models = await agentCliService.listAgentModels();
    const ids = models.map(model => model.id);
    assert.deepEqual(ids, [
      'claude-code',
      'claude-code:sonnet',
      'claude-code:opus',
      'claude-code:haiku',
      'opencode:opencode/big-pickle',
      'opencode:openai/gpt-5.4',
    ]);
    assert.ok(
      models.every(
        model =>
          model.id === model.agentId || model.id.startsWith(`${model.agentId}:`)
      )
    );
    // opencode has no CLI-default entry: a model is required.
    assert.ok(!ids.includes('opencode'));
    const discovered = models.find(
      model => model.id === 'opencode:openai/gpt-5.4'
    );
    assert.equal(discovered.name, 'OpenCode · openai/gpt-5.4');
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test('agents follow the persisted opt-in and the environment pin', async () => {
  // Disabled: no models are offered and access assertions fail closed.
  await setAgentCliModelsEnabled(false);
  assert.equal(await getAgentCliModelsEnabled(), false);
  assert.deepEqual(await agentCliService.listAgentModels(), []);
  await assert.rejects(
    agentCliService.assertAgentAccess('nobody'),
    /disabled/i
  );

  // Enabled again: the persisted setting turns the feature back on.
  await setAgentCliModelsEnabled(true);
  assert.equal(await getAgentCliModelsEnabled(), true);

  // The environment variable pins the value either way and locks the toggle.
  process.env.AGENT_CLI_MODELS_ENABLED = 'false';
  try {
    assert.equal(await getAgentCliModelsEnabled(), false);
    assert.equal(agentCliModelsEnabledLockedByEnv(), true);
    assert.deepEqual(await agentCliService.listAgentModels(), []);
  } finally {
    delete process.env.AGENT_CLI_MODELS_ENABLED;
  }
  assert.equal(agentCliModelsEnabledLockedByEnv(), false);
  assert.equal(await getAgentCliModelsEnabled(), true);
});

// Protocol references: Codex rust-v0.154.0 exec_events.rs and
// event_processor_with_jsonl_output.rs; OpenCode v1.18.31 run.ts and
// session/session.ts getUsage; official @anthropic-ai/claude-agent-sdk ModelUsage;
// installed Pi 0.84.3 json-event.js and pi-ai Usage declaration.
const parseEvents = (parse, events, item = collect()) => {
  for (const event of events)
    parse(JSON.stringify(event), item.queue, item.state);
  return item;
};

test('Codex cumulative totals include caches/reasoning once and replace repeated terminal snapshots', () => {
  const item = parseEvents(parseCodexLine, [
    { type: 'turn.started' },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 100,
        cached_input_tokens: 60,
        cache_write_input_tokens: 10,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    },
    {
      type: 'turn.completed',
      usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 },
    },
  ]);
  assert.deepEqual(agentCliTokenUsage(item.state.usage), {
    promptTokens: 100,
    completionTokens: 20,
    totalTokens: 120,
  });
  parseEvents(
    parseCodexLine,
    [
      { type: 'turn.started' },
      {
        type: 'turn.completed',
        usage: {
          input_tokens: 150,
          cached_input_tokens: 90,
          output_tokens: 40,
        },
      },
    ],
    item
  );
  assert.deepEqual(agentCliTokenUsage(item.state.usage), {
    promptTokens: 150,
    completionTokens: 40,
    totalTokens: 190,
  });
  assert.throws(
    () =>
      parseEvents(
        parseCodexLine,
        [{ type: 'error', message: 'fatal fixture' }],
        item
      ),
    /fatal fixture/
  );
});

test('Claude message snapshots merge by message identity and authoritative per-model totals are not added twice', () => {
  const item = parseEvents(parseClaudeLine, [
    {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: {
        type: 'message_start',
        message: {
          id: 'main',
          usage: {
            input_tokens: 10,
            output_tokens: 0,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 5,
          },
        },
      },
    },
    {
      type: 'stream_event',
      parent_tool_use_id: 'subtask',
      event: {
        type: 'message_start',
        message: { id: 'child', usage: { input_tokens: 2, output_tokens: 0 } },
      },
    },
    {
      type: 'stream_event',
      parent_tool_use_id: null,
      event: { type: 'message_delta', usage: { output_tokens: 5 } },
    },
    {
      type: 'stream_event',
      parent_tool_use_id: 'subtask',
      event: { type: 'message_delta', usage: { output_tokens: 7 } },
    },
    {
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        id: 'main',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      },
    },
  ]);
  assert.deepEqual(agentCliTokenUsage(item.state.usage), {
    promptTokens: 37,
    completionTokens: 12,
    totalTokens: 49,
  });
  const terminal = {
    type: 'result',
    result: 'fixture',
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {
      main: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 5,
        thinkingTokens: 3,
      },
      child: {
        inputTokens: 2,
        outputTokens: 7,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    },
  };
  parseEvents(parseClaudeLine, [terminal, terminal], item);
  assert.deepEqual(agentCliTokenUsage(item.state.usage), {
    promptTokens: 37,
    completionTokens: 12,
    totalTokens: 49,
  });
  const failed = {
    type: 'result',
    is_error: true,
    result: 'failure',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  assert.throws(() => parseEvents(parseClaudeLine, [failed], item), /failure/);
  assert.equal(agentCliTokenUsage(item.state.usage).totalTokens, 49);
  const legacy = parseEvents(parseClaudeLine, [
    {
      type: 'result',
      result: 'legacy',
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 11,
      },
    },
  ]);
  assert.deepEqual(agentCliTokenUsage(legacy.state.usage), {
    promptTokens: 21,
    completionTokens: 2,
    totalTokens: 23,
  });
});

test('OpenCode sums distinct step costs and deduplicates repeated part snapshots with disjoint reasoning', () => {
  const step = (id, tokens) => ({
    type: 'step_finish',
    part: { id, type: 'step-finish', tokens },
  });
  const first = step('one', {
    input: 2,
    output: 3,
    reasoning: 5,
    cache: { read: 7, write: 11 },
    total: 28,
  });
  const item = parseEvents(parseOpencodeLine, [
    first,
    first,
    step('one', { output: 4, total: 29 }),
    step('two', {
      input: 1,
      output: 2,
      reasoning: 4,
      cache: { read: 5, write: 0 },
      total: 12,
    }),
  ]);
  assert.deepEqual(agentCliTokenUsage(item.state.usage), {
    promptTokens: 26,
    completionTokens: 15,
    totalTokens: 41,
  });
});

test('Pi repeated update/end snapshots count each turn once even when reply text already streamed', () => {
  const zero = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
  };
  const first = {
    input: 2,
    output: 6,
    cacheRead: 5,
    cacheWrite: 7,
    reasoning: 4,
    totalTokens: 20,
  };
  const second = {
    input: 1,
    output: 2,
    cacheRead: 3,
    cacheWrite: 4,
    totalTokens: 10,
  };
  const item = parseEvents(parsePiLine, [
    { type: 'turn_start' },
    {
      type: 'message_update',
      usage: zero,
      assistantMessageEvent: { type: 'text_delta', delta: 'reply' },
    },
  ]);
  assert.equal(
    agentCliTokenUsage(item.state.usage),
    undefined,
    'initial synthetic zero snapshots are not provider reports'
  );
  const completed = usage => ({
    role: 'assistant',
    usage,
    content: [{ type: 'text', text: 'reply' }],
  });
  parseEvents(
    parsePiLine,
    [
      {
        type: 'message_update',
        usage: first,
        assistantMessageEvent: { type: 'text_delta', delta: ' continued' },
      },
      { type: 'message_end', message: completed(first) },
      { type: 'turn_end', message: completed(first) },
      { type: 'agent_end', messages: [completed(first)] },
      { type: 'turn_start' },
      { type: 'message_end', message: completed(second) },
      { type: 'turn_end', message: completed(second) },
      { type: 'agent_end', messages: [completed(first), completed(second)] },
    ],
    item
  );
  assert.deepEqual(agentCliTokenUsage(item.state.usage), {
    promptTokens: 22,
    completionTokens: 8,
    totalTokens: 30,
  });
  const reportedZero = parseEvents(parsePiLine, [
    { type: 'turn_end', message: completed(zero) },
  ]);
  assert.deepEqual(agentCliTokenUsage(reportedZero.state.usage), {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });
});

test('missing or malformed CLI usage remains unmetered without deriving tokens from text', () => {
  for (const [parse, event] of [
    [parseClaudeLine, { type: 'result', result: 'many words here' }],
    [
      parseCodexLine,
      {
        type: 'turn.completed',
        usage: { input_tokens: '10', output_tokens: -2 },
      },
    ],
    [
      parseOpencodeLine,
      {
        type: 'step_finish',
        part: { id: 'bad', type: 'step-finish', tokens: { input: null } },
      },
    ],
    [
      parsePiLine,
      {
        type: 'turn_end',
        message: {
          role: 'assistant',
          usage: {},
          content: [{ type: 'text', text: 'reply' }],
        },
      },
    ],
  ])
    assert.equal(
      agentCliTokenUsage(parseEvents(parse, [event]).state.usage),
      undefined
    );
});

async function cliProcessFixture(
  t,
  command,
  events,
  { exitCode = 0, wait = false } = {}
) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-usage-process-')
  );
  const pidFile = path.join(directory, 'pid');
  const program = [
    `#!${process.execPath}`,
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    ...(wait
      ? ["process.on('SIGTERM', () => {});", 'setInterval(() => {}, 1000);']
      : []),
    'process.stdin.resume();',
    "process.stdin.on('end', () => {",
    `process.stdout.write(${JSON.stringify(events.map(event => JSON.stringify(event)).join('\n') + '\n')});`,
    ...(!wait ? [`setTimeout(() => process.exit(${exitCode}), 10);`] : []),
    '});',
  ].join('\n');
  fs.writeFileSync(path.join(directory, command), program, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = directory;
  t.after(async () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, pidFile };
}

const cliFixtureEvents = {
  'claude-code': [
    {
      type: 'result',
      result: 'fixture reply',
      modelUsage: {
        fixture: {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 4,
        },
      },
    },
  ],
  codex: [
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 12,
        output_tokens: 2,
        cached_input_tokens: 3,
        cache_write_input_tokens: 4,
        reasoning_output_tokens: 1,
      },
    },
    {
      type: 'item.completed',
      item: { id: 'reply', type: 'agent_message', text: 'fixture reply' },
    },
  ],
  opencode: [
    {
      type: 'step_finish',
      part: {
        id: 'step',
        type: 'step-finish',
        tokens: {
          input: 5,
          output: 1,
          reasoning: 1,
          cache: { read: 3, write: 4 },
          total: 14,
        },
      },
    },
    {
      type: 'text',
      part: { id: 'reply', type: 'text', text: 'fixture reply' },
    },
  ],
  pi: [
    { type: 'turn_start' },
    {
      type: 'message_update',
      usage: {
        input: 5,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 14,
      },
      assistantMessageEvent: { type: 'text_delta', delta: 'fixture reply' },
    },
    {
      type: 'turn_end',
      message: {
        role: 'assistant',
        usage: {
          input: 5,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          totalTokens: 14,
        },
        content: [{ type: 'text', text: 'fixture reply' }],
      },
    },
  ],
};

let cliUsageAdmin;
async function cliUsageActor() {
  if (!cliUsageAdmin) {
    const { userModel } = await import(distUrl('models/userModel.js'));
    cliUsageAdmin = await userModel.createUser({
      username: 'cli_usage_fixture',
      email: 'cli-usage@example.test',
      password: 'Cli-Usage-Fixture-1!',
      role: 'admin',
      accountStatus: 'active',
    });
  }
  return cliUsageAdmin.id;
}

for (const agent of ['claude-code', 'codex', 'opencode', 'pi']) {
  test(`${agent} records one metered successful process invocation`, async t => {
    const actor = await cliUsageActor();
    const definition = AGENT_CLI_DEFINITIONS.find(item => item.id === agent);
    const fixture = await cliProcessFixture(
      t,
      definition.command,
      cliFixtureEvents[agent]
    );
    const { default: usageService } = await import(
      distUrl('services/pluginUsageService.js')
    );
    const records = [];
    t.mock.method(usageService, 'record', async input => {
      records.push(input);
    });
    const chunks = [];
    for await (const chunk of agentCliService.executeAgentStreamRequest(
      agent,
      [{ id: 'user', role: 'user', content: 'Fixture only', timestamp: 1 }],
      actor,
      { model: `${agent}:fixture/model`, cwd: fixture.directory }
    ))
      chunks.push(chunk);
    assert.equal(records.length, 1);
    assert.equal(records[0].pluginId, `agent-cli:${agent}`);
    assert.equal(records[0].userId, actor);
    assert.equal(records[0].status, 'success');
    assert.deepEqual(records[0].tokens, {
      promptTokens: 12,
      completionTokens: 2,
      totalTokens: 14,
    });
    assert.equal(chunks.filter(chunk => chunk.type === 'usage').length, 1);
    assert.equal(chunks.at(-1).type, 'done');
  });
}

test('a nonzero CLI exit with partial text records failure with its reported tokens', async t => {
  const fixture = await cliProcessFixture(t, 'codex', cliFixtureEvents.codex, {
    exitCode: 2,
  });
  const { default: usageService } = await import(
    distUrl('services/pluginUsageService.js')
  );
  const records = [];
  t.mock.method(usageService, 'record', async input => {
    records.push(input);
  });
  await assert.rejects(async () => {
    for await (const _chunk of agentCliService.executeAgentStreamRequest(
      'codex',
      [{ id: 'u', role: 'user', content: 'Fixture', timestamp: 1 }],
      await cliUsageActor(),
      { cwd: fixture.directory }
    )) {
      /* drain */
    }
  }, /exited unsuccessfully/);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'error');
  assert.equal(records[0].tokens.totalTokens, 14);
});

for (const stop of ['abort', 'return', 'throw']) {
  test(`CLI consumer ${stop} stops the fixture process and records one cancellation`, async t => {
    const fixture = await cliProcessFixture(
      t,
      'codex',
      cliFixtureEvents.codex,
      { wait: true }
    );
    const { default: usageService } = await import(
      distUrl('services/pluginUsageService.js')
    );
    const records = [];
    t.mock.method(usageService, 'record', async input => {
      records.push(input);
    });
    const controller = new AbortController();
    const stream = agentCliService.executeAgentStreamRequest(
      'codex',
      [{ id: 'u', role: 'user', content: 'Fixture', timestamp: 1 }],
      await cliUsageActor(),
      { cwd: fixture.directory, signal: controller.signal }
    );
    assert.equal((await stream.next()).value.type, 'content');
    if (stop === 'abort') {
      controller.abort(new Error('Stop fixture CLI'));
      await assert.rejects(stream.next(), /Stop fixture CLI/);
    } else if (stop === 'return') await stream.return();
    else
      await assert.rejects(
        stream.throw(new Error('Consumer failed')),
        /Consumer failed/
      );
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'cancelled');
    assert.equal(records[0].tokens.totalTokens, 14);
    const pid = Number(fs.readFileSync(fixture.pidFile, 'utf8'));
    let alive = true;
    for (let attempt = 0; alive && attempt < 150; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise(resolve => setTimeout(resolve, 10));
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
        alive = false;
      }
    }
    assert.equal(
      alive,
      false,
      'SIGKILL follows ignored SIGTERM within the bounded cleanup window'
    );
    assert.equal(records.length, 1);
  });
}
