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
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serviceUrl = pathToFileURL(
  path.join(__dirname, '..', 'backend', 'dist', 'services', 'agentCliService.js')
).href;

const {
  AGENT_CLI_DEFINITIONS,
  parseOpencodeLine,
  parsePiLine,
  parseClaudeLine,
  default: agentCliService,
} = await import(serviceUrl);

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
  assert.deepEqual(definition('opencode').buildArgs('openai/gpt-5.4').slice(-2), [
    '-m',
    'openai/gpt-5.4',
  ]);
  assert.deepEqual(definition('pi').buildArgs('provider/model').slice(-2), [
    '--model',
    'provider/model',
  ]);
});

test('pi runs stateless, tool-less, with a neutral system prompt', () => {
  const args = definition('pi').buildArgs();
  assert.ok(args.includes('--no-session'), 'must not touch the server user session store');
  assert.ok(args.includes('--no-tools'), 'chat replies must not run local tools');
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
    chunks.filter(chunk => chunk.type === 'content').map(chunk => chunk.content),
    ['po', 'ng']
  );
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === 'reasoning').map(chunk => chunk.content),
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
      models.every(model =>
        model.id === model.agentId || model.id.startsWith(`${model.agentId}:`)
      )
    );
    // opencode has no CLI-default entry: a model is required.
    assert.ok(!ids.includes('opencode'));
    const discovered = models.find(model => model.id === 'opencode:openai/gpt-5.4');
    assert.equal(discovered.name, 'OpenCode · openai/gpt-5.4');
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});
