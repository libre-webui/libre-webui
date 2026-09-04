import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseLaunchArgs } = require('../bin/cli-args.js');

test('launch flags map onto the environment the backend reads', () => {
  const { env, errors } = parseLaunchArgs([
    '--port',
    '3000',
    '--model',
    'llama3.2',
    '--ollama-url',
    'http://127.0.0.1:11434',
    '--no-open',
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(env, {
    PORT: '3000',
    DEFAULT_MODEL: 'llama3.2',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
    OPEN_BROWSER: 'false',
  });
});

test('short and inline forms are accepted and values are trimmed', () => {
  const { env, errors } = parseLaunchArgs([
    '-p=8090',
    '-m',
    '  qwen3:8b ',
    '--ollama-url=http://ollama:11434',
  ]);
  assert.deepEqual(errors, []);
  assert.equal(env.PORT, '8090');
  assert.equal(env.DEFAULT_MODEL, 'qwen3:8b');
  assert.equal(env.OLLAMA_BASE_URL, 'http://ollama:11434');
});

test('a value flag without a value or a bad port is refused', () => {
  const missing = parseLaunchArgs(['--model', '--no-open']);
  assert.deepEqual(missing.env, { OPEN_BROWSER: 'false' });
  assert.deepEqual(missing.errors, ['--model requires a value']);

  const badPort = parseLaunchArgs(['--port', 'eighty']);
  assert.deepEqual(badPort.env, {});
  assert.match(badPort.errors[0], /--port must be a port number/);
});

test('unknown arguments pass through untouched', () => {
  const { env, errors } = parseLaunchArgs(['--verbose', 'extra']);
  assert.deepEqual(env, {});
  assert.deepEqual(errors, []);
});
