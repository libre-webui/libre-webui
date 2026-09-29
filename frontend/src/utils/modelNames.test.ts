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
import test from 'node:test';
import {
  formatContextLength,
  formatModelName,
  formatModelSize,
  modelNameParts,
} from './modelNames';

test('path ids read as a name, a vendor, and a tag', () => {
  assert.deepEqual(modelNameParts('~anthropic/claude-fable-latest'), {
    name: 'Claude Fable',
    vendor: 'Anthropic',
    tag: 'latest',
  });
  assert.deepEqual(modelNameParts('hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M'), {
    name: 'LFM2.5 2.6B',
    vendor: 'LiquidAI',
    tag: 'Q4_K_M',
  });
  assert.deepEqual(modelNameParts('hf.co/prism-ml/Ternary-Bonsai-27B'), {
    name: 'Ternary Bonsai 27B',
    vendor: 'Prism ML',
  });
  assert.deepEqual(modelNameParts('x-ai/grok-4.1-fast'), {
    name: 'Grok 4.1 Fast',
    vendor: 'xAI',
  });
  assert.deepEqual(modelNameParts('qwen/qwen3-235b-a22b-2507'), {
    name: 'Qwen3 235B A22B 2507',
    vendor: 'Qwen',
  });
});

test('bare Ollama names stay exactly as typed', () => {
  assert.deepEqual(modelNameParts('llama3.2:3b'), { name: 'llama3.2:3b' });
  assert.deepEqual(modelNameParts('smollm2:latest'), {
    name: 'smollm2:latest',
  });
});

test('provider ids read cleanly when asked', () => {
  const pretty = (id: string) => modelNameParts(id, { prettify: true }).name;
  assert.equal(pretty('gpt-5.4'), 'GPT 5.4');
  assert.equal(pretty('deepseek-v4-pro'), 'DeepSeek V4 Pro');
  assert.equal(pretty('claude-sonnet-5-5'), 'Claude Sonnet 5.5');
  assert.equal(
    pretty('claude-3-5-haiku-20241022'),
    'Claude 3.5 Haiku 20241022'
  );
  assert.equal(pretty('o4-mini'), 'o4 Mini');
  assert.equal(pretty('gpt-4o'), 'GPT 4o');
  assert.equal(pretty('kimi-k2-thinking'), 'Kimi K2 Thinking');
  assert.equal(pretty('gemma-3n-e4b'), 'Gemma 3n E4B');
  assert.equal(formatModelName('model-gguf'), 'Model');
});

test('context and size read in short units', () => {
  assert.equal(formatContextLength(200000), '200K');
  assert.equal(formatContextLength(131072), '128K');
  assert.equal(formatContextLength(1048576), '1M');
  assert.equal(formatContextLength(2000000), '2M');
  assert.equal(formatContextLength(0), '');
  assert.equal(formatModelSize(1_600_000_000), '1.6 GB');
  assert.equal(formatModelSize(45_000_000), '45 MB');
});
