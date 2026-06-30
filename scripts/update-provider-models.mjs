#!/usr/bin/env node
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

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const pluginsDir = path.join(repoRoot, 'plugins');

const providerArg = process.argv[2]?.toLowerCase();
const requestedProviders = providerArg
  ? providerArg === 'all'
    ? []
    : providerArg
        .split(',')
        .map(provider => provider.trim())
        .filter(Boolean)
  : [];

const fallbackModels = {
  openai: [
    'gpt-5.5',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.2',
    'gpt-5.2-chat-latest',
    'gpt-5.2-pro',
    'gpt-5.1',
    'gpt-5.1-chat-latest',
    'gpt-5.1-codex',
    'gpt-5',
    'gpt-5-chat-latest',
    'gpt-5-mini',
    'gpt-5-nano',
    'gpt-5-pro',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4.1-nano',
    'gpt-4o',
    'gpt-4o-mini',
    'chatgpt-4o-latest',
    'o4-mini',
    'o4-mini-deep-research',
    'o3',
    'o3-mini',
    'o1',
    'o1-pro',
  ],
  anthropic: [
    'claude-sonnet-5',
    'claude-fable-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-opus-4-5-20251101',
    'claude-haiku-4-5-20251001',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-1-20250805',
  ],
  groq: [
    'groq/compound',
    'groq/compound-mini',
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3.6-27b',
    'qwen/qwen3-32b',
  ],
  gemini: [
    'gemini-3-pro-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-flash-latest',
    'gemini-flash-lite-latest',
    'gemini-pro-latest',
    'gemma-3-27b-it',
    'gemma-3-12b-it',
    'gemma-3-4b-it',
    'gemma-3-1b-it',
    'gemma-3n-e4b-it',
    'gemma-3n-e2b-it',
  ],
  mistral: [
    'mistral-medium-latest',
    'mistral-small-latest',
    'mistral-large-latest',
    'codestral-latest',
    'devstral-latest',
    'devstral-medium-latest',
    'devstral-small-latest',
    'magistral-medium-latest',
    'magistral-small-latest',
    'ministral-14b-latest',
    'ministral-8b-latest',
    'ministral-3b-latest',
    'pixtral-large-latest',
    'pixtral-12b-latest',
    'voxtral-small-latest',
    'voxtral-mini-latest',
  ],
};

const updateOrder = [
  'openai',
  'anthropic',
  'groq',
  'gemini',
  'mistral',
  'github',
  'openrouter',
  'huggingface',
];

function shouldUpdate(provider) {
  return (
    requestedProviders.length === 0 || requestedProviders.includes(provider)
  );
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadEnvFile(filePath) {
  if (!(await fileExists(filePath))) {
    return;
  }

  const content = await fs.readFile(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key]) {
      continue;
    }

    process.env[key] = rawValue.trim().replace(/^['"]|['"]$/g, '');
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'Libre-WebUI-Model-Updater',
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json();
}

function uniqueSorted(models) {
  return [
    ...new Set(models.filter(Boolean).map(model => String(model).trim())),
  ].sort((a, b) => a.localeCompare(b));
}

function chatModelFilter(model) {
  const lower = model.toLowerCase();
  const blocked = [
    'audio',
    'dall-e',
    'embedding',
    'image',
    'moderation',
    'realtime',
    'search-api',
    'transcribe',
    'tts',
    'whisper',
  ];

  return !blocked.some(fragment => lower.includes(fragment));
}

async function updatePlugin(pluginId, updates) {
  const pluginPath = path.join(pluginsDir, `${pluginId}.json`);
  const plugin = JSON.parse(await fs.readFile(pluginPath, 'utf8'));
  const nextPlugin = {
    ...plugin,
    ...updates,
    model_map: uniqueSorted(updates.model_map ?? plugin.model_map ?? []),
  };

  await fs.writeFile(pluginPath, `${JSON.stringify(nextPlugin, null, 2)}\n`);
  console.log(
    `${pluginId}: ${plugin.model_map?.length ?? 0} -> ${nextPlugin.model_map.length} models`
  );
}

async function fromOpenAI() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    return fallbackModels.openai;
  }

  const payload = await fetchJson('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });

  const models = payload.data
    .map(model => model.id)
    .filter(model => /^(chatgpt|gpt-|o[0-9])/.test(model))
    .filter(chatModelFilter);

  return models.length ? models : fallbackModels.openai;
}

async function fromAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return fallbackModels.anthropic;
  }

  const payload = await fetchJson('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
  });

  const models = payload.data.map(model => model.id);
  return models.length ? models : fallbackModels.anthropic;
}

async function fromGroq() {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return fallbackModels.groq;
  }

  const payload = await fetchJson('https://api.groq.com/openai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });

  const models = payload.data.map(model => model.id).filter(chatModelFilter);
  return models.length ? models : fallbackModels.groq;
}

async function fromGemini() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    return fallbackModels.gemini;
  }

  const payload = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
  );

  const models = payload.models
    .filter(model =>
      model.supportedGenerationMethods?.includes('generateContent')
    )
    .map(model => model.name.replace(/^models\//, ''))
    .filter(chatModelFilter);

  return models.length ? models : fallbackModels.gemini;
}

async function fromMistral() {
  const key = process.env.MISTRAL_API_KEY;
  if (!key) {
    return fallbackModels.mistral;
  }

  const payload = await fetchJson('https://api.mistral.ai/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });

  const models = payload.data
    .map(model => model.id)
    .filter(
      model => !/embed|moderation|audio|voxtral-mini-transcribe/i.test(model)
    );

  return models.length ? models : fallbackModels.mistral;
}

async function fromGitHubModels() {
  const payload = await fetchJson('https://models.github.ai/catalog/models');
  return payload
    .filter(model => model.supported_output_modalities?.includes('text'))
    .map(model => model.id);
}

async function fromOpenRouter() {
  const payload = await fetchJson('https://openrouter.ai/api/v1/models');
  return payload.data
    .filter(model =>
      ['text->text', 'text+image->text'].includes(model.architecture?.modality)
    )
    .map(model => model.id)
    .filter(model => !model.startsWith('~'));
}

async function fromHuggingFaceRouter() {
  const payload = await fetchJson('https://router.huggingface.co/v1/models');
  return payload.data
    .filter(model => model.architecture?.output_modalities?.includes('text'))
    .filter(model =>
      model.providers?.some(provider => provider.status === 'live')
    )
    .map(model => model.id);
}

const providerUpdaters = {
  async openai() {
    await updatePlugin('openai', { model_map: await fromOpenAI() });
  },
  async anthropic() {
    await updatePlugin('anthropic', { model_map: await fromAnthropic() });
  },
  async groq() {
    await updatePlugin('groq', { model_map: await fromGroq() });
  },
  async gemini() {
    await updatePlugin('gemini', { model_map: await fromGemini() });
  },
  async mistral() {
    await updatePlugin('mistral', { model_map: await fromMistral() });
  },
  async github() {
    await updatePlugin('github', {
      endpoint: 'https://models.github.ai/inference/chat/completions',
      model_map: await fromGitHubModels(),
    });
  },
  async openrouter() {
    await updatePlugin('openrouter', { model_map: await fromOpenRouter() });
  },
  async huggingface() {
    await updatePlugin('huggingface', {
      model_map: await fromHuggingFaceRouter(),
    });
  },
};

async function main() {
  await loadEnvFile(path.join(repoRoot, 'backend', '.env'));

  const unknown = requestedProviders.filter(
    provider => !providerUpdaters[provider]
  );
  if (unknown.length) {
    throw new Error(`Unknown provider(s): ${unknown.join(', ')}`);
  }

  for (const provider of updateOrder) {
    if (!shouldUpdate(provider)) {
      continue;
    }

    try {
      await providerUpdaters[provider]();
    } catch (error) {
      console.warn(`${provider}: skipped (${error.message})`);
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
