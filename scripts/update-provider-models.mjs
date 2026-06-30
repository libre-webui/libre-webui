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

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      'User-Agent': 'Libre-WebUI-Model-Updater',
      Accept: 'text/html,text/markdown,text/plain;q=0.9,*/*;q=0.8',
      ...(options.headers ?? {}),
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.text();
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

function requireModels(provider, source, models) {
  const cleaned = uniqueSorted(models);
  if (!cleaned.length) {
    throw new Error(`no chat models returned from ${source}`);
  }

  console.log(`${provider}: using ${source}`);
  return cleaned;
}

function extractMatches(content, pattern) {
  return [...content.matchAll(pattern)].map(match => match[1]);
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
  if (key) {
    const payload = await fetchJson('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });

    const models = payload.data
      .map(model => model.id)
      .filter(model => /^(chatgpt|gpt-|o[0-9])/.test(model))
      .filter(chatModelFilter);

    return requireModels('openai', 'OpenAI /v1/models', models);
  }

  const html = await fetchText('https://developers.openai.com/api/docs/models');
  const models = extractMatches(
    html,
    /href="\/api\/docs\/models\/([^"#?]+)"/g
  )
    .filter(model => /^(gpt-|o[0-9])/.test(model))
    .filter(chatModelFilter);

  return requireModels('openai', 'OpenAI official model docs', models);
}

async function fromAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY is not configured');
  }

  const payload = await fetchJson('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
  });

  const models = payload.data.map(model => model.id);
  return requireModels('anthropic', 'Anthropic /v1/models', models);
}

async function fromGroq() {
  const key = process.env.GROQ_API_KEY;
  const groqFilter = model => {
    const lower = model.toLowerCase();
    return (
      chatModelFilter(model) &&
      !lower.endsWith('-limits') &&
      !lower.endsWith('-price') &&
      !lower.includes('guard') &&
      !lower.includes('safeguard') &&
      !lower.includes('whisper') &&
      !lower.includes('playai') &&
      !lower.includes('canopylabs')
    );
  };

  if (key) {
    const payload = await fetchJson('https://api.groq.com/openai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });

    const models = payload.data.map(model => model.id).filter(groqFilter);
    return requireModels('groq', 'Groq /openai/v1/models', models);
  }

  const html = await fetchText('https://console.groq.com/docs/models');
  const models = extractMatches(
    html,
    /\b((?:groq\/compound(?:-mini)?|llama-[0-9.]+-[0-9a-z-]+|meta-llama\/llama-[0-9a-z.-]+|moonshotai\/kimi-[0-9a-z.-]+|openai\/gpt-oss-[0-9a-z-]+|qwen\/qwen[0-9a-z.-]+))\b/gi
  )
    .map(model => model.toLowerCase())
    .filter(groqFilter);

  return requireModels('groq', 'Groq official model docs', models);
}

async function fromGemini() {
  const key = process.env.GEMINI_API_KEY;
  const geminiChatFilter = model => {
    const lower = model.toLowerCase();
    return (
      /^gemini-/.test(lower) &&
      chatModelFilter(model) &&
      !lower.includes('image') &&
      !lower.includes('live') &&
      !lower.includes('native-audio') &&
      !lower.includes('tts') &&
      !lower.includes('veo') &&
      !lower.includes('imagen') &&
      !lower.includes('lyria') &&
      !lower.includes('embedding') &&
      !lower.includes('robotics') &&
      !lower.includes('deep-research') &&
      !lower.includes('computer-use') &&
      !lower.includes('antigravity') &&
      !lower.includes('omni')
    );
  };

  if (key) {
    const payload = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`
    );

    const models = payload.models
      .filter(model =>
        model.supportedGenerationMethods?.includes('generateContent')
      )
      .map(model => model.name.replace(/^models\//, ''))
      .filter(geminiChatFilter);

    return requireModels('gemini', 'Gemini model API', models);
  }

  const docs = await fetchText(
    'https://ai.google.dev/gemini-api/docs/models.md.txt'
  );
  const currentDocs = docs.split('## Previous models')[0] ?? docs;
  const models = extractMatches(currentDocs, /\/models\/([a-z0-9.-]+)/g).filter(
    geminiChatFilter
  );

  const latestAliasMatches = [
    ...docs.matchAll(/\b(gemini-[a-z-]+-latest)\b/g),
  ].map(match => match[1]);

  return requireModels('gemini', 'Gemini official model docs', [
    ...models,
    ...latestAliasMatches,
  ]);
}

async function fromMistral() {
  const key = process.env.MISTRAL_API_KEY;
  const mistralChatFilter = model =>
    !/embed|moderation|ocr|transcribe|tts/i.test(model);

  if (key) {
    const payload = await fetchJson('https://api.mistral.ai/v1/models', {
      headers: { Authorization: `Bearer ${key}` },
    });

    const models = payload.data
      .map(model => model.id)
      .filter(mistralChatFilter);

    return requireModels('mistral', 'Mistral /v1/models', models);
  }

  const html = await fetchText(
    'https://docs.mistral.ai/getting-started/models/models_overview/'
  );
  const models = extractMatches(
    html,
    /href="\/models\/model-cards\/([^"?#]+)"/g
  ).filter(mistralChatFilter);

  return requireModels('mistral', 'Mistral official model docs', models);
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
