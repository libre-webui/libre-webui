import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
const testDataDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), 'libre-thinking-level-')
);
process.env.DATA_DIR = testDataDirectory;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

/** Requests Ollama received, so the wire form can be asserted on. */
const ollamaRequests = [];
/** Capabilities `/api/show` reports, per model. */
const modelCapabilities = new Map([
  ['thinker', ['completion', 'thinking']],
  ['plain', ['completion']],
]);

const ollamaStub = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => {
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    ollamaRequests.push({ url: request.url, body });

    if (request.url === '/api/show') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          parameters: '',
          model_info: {},
          capabilities: modelCapabilities.get(body.model) ?? [],
        })
      );
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        model: body.model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'ok' },
        done: true,
      })
    );
  });
});

await new Promise(resolve => ollamaStub.listen(0, '127.0.0.1', resolve));
process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${ollamaStub.address().port}`;

const backendImport = segments =>
  import(pathToFileURL(path.join(repoRoot, 'backend', 'dist', ...segments)).href);

const thinking = await backendImport(['utils', 'thinkingOptions.js']);
const modelDefaults = await backendImport(['utils', 'ollamaModelDefaults.js']);
const chatAdapter = await backendImport(['utils', 'pluginChatAdapter.js']);
const ollamaModule = await backendImport(['services', 'ollamaService.js']);
const ollamaService = ollamaModule.default;

after(() => {
  ollamaStub.close();
  fs.rmSync(testDataDirectory, { recursive: true, force: true });
});

const message = content => [
  { id: 'm1', role: 'user', content, timestamp: 1 },
];

const requestsTo = url => ollamaRequests.filter(entry => entry.url === url);

test('a thinking setting is read only in the forms a provider can use', () => {
  assert.equal(thinking.normalizeThinkingPreference('high'), 'high');
  assert.equal(thinking.normalizeThinkingPreference(true), true);
  assert.equal(thinking.normalizeThinkingPreference(false), false);
  assert.equal(thinking.normalizeThinkingPreference(null), undefined);
  assert.equal(thinking.normalizeThinkingPreference('maximum'), undefined);

  assert.equal(thinking.thinkingEffort(true), 'medium');
  assert.equal(thinking.thinkingEffort('low'), 'low');
  assert.equal(thinking.thinkingEffort(false), undefined);
  assert.equal(thinking.thinkingEffort(null), undefined);

  assert.equal(thinking.thinkingBudgetTokens('low'), 2048);
  assert.equal(thinking.thinkingBudgetTokens(false), undefined);
  // A reply has to fit beside the reasoning that produced it.
  assert.ok(thinking.maxTokensForBudget(1024, 8192) > 8192);
  assert.equal(thinking.maxTokensForBudget(64000, 8192), 64000);
});

test('the setting is lifted out of the options it travels with', () => {
  const split = thinking.splitThinkingOption({
    temperature: 0.4,
    think: 'high',
  });
  assert.equal(split.think, 'high');
  assert.deepEqual(split.options, { temperature: 0.4 });

  assert.deepEqual(
    ollamaModule.sanitizeOptionsForModel('thinker', {
      num_ctx: 4096,
      think: true,
    }),
    { num_ctx: 4096 },
    'Ollama takes think beside the options, never inside them'
  );
});

test('a model reports whether it reasons at all', () => {
  const reasoning = modelDefaults.parseOllamaModelDefaults({
    parameters: '',
    capabilities: ['completion', 'thinking'],
  });
  assert.deepEqual(reasoning.capabilities, ['completion', 'thinking']);
  assert.equal(reasoning.supportsThinking, true);

  assert.equal(
    modelDefaults.parseOllamaModelDefaults({
      parameters: '',
      capabilities: ['completion'],
    }).supportsThinking,
    false
  );

  // Ollama versions that report nothing say nothing, which is not the same as
  // a model that cannot reason.
  assert.equal(
    modelDefaults.parseOllamaModelDefaults({ parameters: '' }).supportsThinking,
    undefined
  );
});

test('Ollama receives the level in the request body', async () => {
  ollamaRequests.length = 0;
  await ollamaService.generateChatResponse({
    model: 'thinker',
    messages: [{ role: 'user', content: 'hello' }],
    options: { temperature: 0.5, think: 'high' },
  });

  const [chat] = requestsTo('/api/chat');
  assert.equal(chat.body.think, 'high');
  assert.deepEqual(chat.body.options, { temperature: 0.5 });
});

test('a model that cannot reason is not asked to', async () => {
  ollamaRequests.length = 0;
  await ollamaService.generateChatResponse({
    model: 'plain',
    messages: [{ role: 'user', content: 'hello' }],
    options: { think: true },
  });

  const [chat] = requestsTo('/api/chat');
  assert.ok(
    !('think' in chat.body),
    'asking a plain model to think is a 400 from Ollama'
  );
});

test('a request that says nothing about thinking still says nothing', async () => {
  ollamaRequests.length = 0;
  await ollamaService.generateChatResponse({
    model: 'thinker',
    messages: [{ role: 'user', content: 'hello' }],
    options: { temperature: 0.5 },
  });

  const [chat] = requestsTo('/api/chat');
  assert.ok(!('think' in chat.body));
  assert.equal(
    requestsTo('/api/show').length,
    0,
    'a request with no thinking setting should not cost a capability lookup'
  );
});

test('OpenAI-compatible providers receive a reasoning effort', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    { id: 'openai', name: 'OpenAI' },
    'gpt-5',
    message('hello'),
    { think: 'high' }
  );
  assert.equal(payload.reasoning_effort, 'high');

  const { payload: quiet } = chatAdapter.buildPluginChatPayload(
    { id: 'openai', name: 'OpenAI' },
    'gpt-5',
    message('hello'),
    {}
  );
  assert.ok(
    !('reasoning_effort' in quiet),
    'a model that was never asked to reason should not carry the field'
  );
});

test('the Responses API receives the effort in its own shape', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    { id: 'openai', name: 'OpenAI' },
    'gpt-5',
    message('hello'),
    { think: true },
    {},
    undefined,
    'responses'
  );
  assert.deepEqual(payload.reasoning, { effort: 'medium' });
});

test('Anthropic receives a budget, and no sampling beside it', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    { id: 'anthropic', name: 'Anthropic' },
    'claude-sonnet-4-5',
    message('hello'),
    { think: 'medium', num_predict: 1024 }
  );
  assert.deepEqual(payload.thinking, {
    type: 'enabled',
    budget_tokens: 8192,
  });
  assert.ok(
    payload.max_tokens > 8192,
    'the answer needs room beyond the reasoning budget'
  );
  assert.ok(!('temperature' in payload));
  assert.ok(!('top_p' in payload));

  // Without a thinking setting the sampling behaviour is unchanged.
  const { payload: sampled } = chatAdapter.buildPluginChatPayload(
    { id: 'anthropic', name: 'Anthropic' },
    'claude-sonnet-4-5',
    message('hello'),
    { num_predict: 1024 }
  );
  assert.ok(!('thinking' in sampled));
  assert.equal(sampled.max_tokens, 1024);
  assert.equal(typeof sampled.temperature, 'number');
});

test('Gemini receives a thinking budget in its generation config', () => {
  const { payload } = chatAdapter.buildPluginChatPayload(
    { id: 'gemini', name: 'Gemini' },
    'gemini-2.5-flash',
    message('hello'),
    { think: 'low' }
  );
  assert.deepEqual(payload.generationConfig.thinkingConfig, {
    thinkingBudget: 2048,
  });

  const { payload: quiet } = chatAdapter.buildPluginChatPayload(
    { id: 'gemini', name: 'Gemini' },
    'gemini-2.5-flash',
    message('hello'),
    {}
  );
  assert.ok(!('thinkingConfig' in quiet.generationConfig));
});
