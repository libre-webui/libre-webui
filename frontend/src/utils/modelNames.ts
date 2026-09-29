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

/**
 * Readable names for raw model ids. "~anthropic/claude-fable-latest" reads
 * as "Claude Fable" by Anthropic with a "latest" tag, and
 * "hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M" as "LFM2.5 2.6B" tagged Q4_K_M.
 * The raw id stays the value; this is presentation only.
 */

export interface ModelNameParts {
  /** Readable model name. */
  name: string;
  /** The organisation from a path id, e.g. "Anthropic". */
  vendor?: string;
  /** A quantization, version tag, or moving alias. */
  tag?: string;
}

const WORDS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  awq: 'AWQ',
  bf16: 'BF16',
  chatgpt: 'ChatGPT',
  deepseek: 'DeepSeek',
  fp16: 'FP16',
  fp8: 'FP8',
  glm: 'GLM',
  gpt: 'GPT',
  gptq: 'GPTQ',
  hd: 'HD',
  lfm: 'LFM',
  llm: 'LLM',
  minimax: 'MiniMax',
  mlx: 'MLX',
  ml: 'ML',
  moe: 'MoE',
  openai: 'OpenAI',
  oss: 'OSS',
  qwq: 'QwQ',
  tts: 'TTS',
  vl: 'VL',
  xl: 'XL',
};

const VENDORS: Record<string, string> = {
  'meta-llama': 'Meta',
  'x-ai': 'xAI',
  'z-ai': 'Z.ai',
  amazon: 'Amazon',
  anthropic: 'Anthropic',
  cohere: 'Cohere',
  deepseek: 'DeepSeek',
  google: 'Google',
  liquid: 'Liquid AI',
  microsoft: 'Microsoft',
  minimax: 'MiniMax',
  mistralai: 'Mistral',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  perplexity: 'Perplexity',
  qwen: 'Qwen',
};

const REGISTRY_PREFIX = /^(?:hf\.co|huggingface\.co)\//i;
const NOISE_TOKENS = new Set(['gguf']);

function formatToken(token: string): string {
  const lower = token.toLowerCase();
  if (WORDS[lower]) return WORDS[lower];
  // Already cased by its author: LFM2.5, MiniLM, 4o.
  if (token !== lower) return token;
  // OpenAI's o-series stays lowercase.
  if (/^o\d/.test(token)) return token;
  // Sizes and short version codes: 27b, 1.5b, v4, k2, a22b, e4b.
  if (/^\d+(?:\.\d+)?[bkmt]$/.test(token)) return token.toUpperCase();
  if (/^[a-z]\d+(?:\.\d+)?[a-z]?$/.test(token)) return token.toUpperCase();
  if (/^\d/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/**
 * "claude-opus-4-5" -> "Claude Opus 4.5". Runs of one- or two-digit numbers
 * after a word are a dashed version, the way Anthropic writes them.
 */
export function formatModelName(base: string): string {
  const raw = base.split(/[-_\s]+/).filter(Boolean);
  const tokens =
    raw.length > 1
      ? raw.filter(token => !NOISE_TOKENS.has(token.toLowerCase()))
      : raw;
  const out: string[] = [];
  for (const token of tokens) {
    const previous = out[out.length - 1];
    if (
      previous &&
      /^\d{1,2}$/.test(token) &&
      /^\d{1,2}$/.test(previous) &&
      out.length > 1 &&
      !/^\d/.test(out[out.length - 2])
    ) {
      out[out.length - 1] = `${previous}.${token}`;
      continue;
    }
    out.push(formatToken(token));
  }
  return out.join(' ') || base;
}

export function formatVendor(vendor: string): string {
  const lower = vendor.toLowerCase();
  if (VENDORS[lower]) return VENDORS[lower];
  if (vendor !== lower) return vendor;
  return formatModelName(vendor);
}

/**
 * Split a raw id into its readable parts. Bare Ollama names such as
 * "llama3.2:3b" are what people type and are left exactly as they are.
 */
export function modelNameParts(
  id: string,
  options: { prettify?: boolean } = {}
): ModelNameParts {
  const trimmed = id.trim();
  const alias = trimmed.startsWith('~');
  const withoutAlias = alias ? trimmed.slice(1) : trimmed;
  const path = withoutAlias.replace(REGISTRY_PREFIX, '');
  const segments = path.split('/').filter(Boolean);
  const prettify = options.prettify ?? segments.length > 1;
  if (!prettify || segments.length === 0) return { name: trimmed };

  let base = segments[segments.length - 1];
  let tag: string | undefined;
  const colon = base.lastIndexOf(':');
  if (colon > 0) {
    tag = base.slice(colon + 1) || undefined;
    base = base.slice(0, colon);
  }
  // A "~vendor/model-latest" alias moves with each release.
  if (alias && /[-_]latest$/i.test(base)) {
    base = base.replace(/[-_]latest$/i, '');
    tag = tag ?? 'latest';
  }
  if (tag === 'latest' && !alias) tag = undefined;

  const vendor =
    segments.length > 1
      ? formatVendor(segments[segments.length - 2])
      : undefined;
  return {
    name: formatModelName(base),
    ...(vendor ? { vendor } : {}),
    ...(tag ? { tag } : {}),
  };
}

/** 200000 -> "200K", 1048576 -> "1M". */
export function formatContextLength(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '';
  if (tokens >= 1_000_000) {
    const millions =
      tokens % 1_048_576 === 0 ? tokens / 1_048_576 : tokens / 1_000_000;
    return `${Number(millions.toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    const thousands = tokens % 1024 === 0 ? tokens / 1024 : tokens / 1000;
    return `${Math.round(thousands)}K`;
  }
  return String(tokens);
}

/** Bytes on disk, e.g. "1.6 GB". */
export function formatModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
