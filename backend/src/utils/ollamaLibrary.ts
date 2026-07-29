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

import { createLogger } from './logger.js';

const logger = createLogger('utils:ollama-library');

export interface RemoteModelInfo {
  name: string;
  description: string;
  category: string;
  sizes: string[];
  pulls?: string;
  tags?: string[];
}

export interface OllamaLibraryQuery {
  search?: string;
  sort?: string;
  category?: string;
  pages?: number;
}

const MODEL_CAPABILITY_TAGS = new Set([
  'audio',
  'cloud',
  'embedding',
  'thinking',
  'tools',
  'vision',
]);

const CURATED_MODELS: RemoteModelInfo[] = [
  {
    name: 'deepseek-r1',
    description: 'Family of open reasoning models with exceptional performance',
    category: 'reasoning',
    sizes: ['1.5b', '7b', '8b', '14b', '32b', '70b', '671b'],
    pulls: '200M+',
    tags: ['reasoning', 'thinking'],
  },
  {
    name: 'llama3.2',
    description: "Meta's latest Llama model, great for general tasks",
    category: 'general',
    sizes: ['1b', '3b'],
    pulls: '50M+',
    tags: ['general', 'fast'],
  },
  {
    name: 'llama3.1',
    description: 'State-of-the-art model from Meta with tool support',
    category: 'general',
    sizes: ['8b', '70b', '405b'],
    pulls: '100M+',
    tags: ['tools', 'general'],
  },
  {
    name: 'gemma3',
    description: "Google's most capable model that runs on a single GPU",
    category: 'general',
    sizes: ['1b', '4b', '12b', '27b'],
    pulls: '30M+',
    tags: ['vision', 'general'],
  },
  {
    name: 'qwen2.5',
    description: 'Latest Qwen model with strong multilingual capabilities',
    category: 'general',
    sizes: ['0.5b', '1.5b', '3b', '7b', '14b', '32b', '72b'],
    pulls: '20M+',
    tags: ['multilingual', 'coding'],
  },
  {
    name: 'qwen2.5-coder',
    description: 'Code-focused Qwen model for development tasks',
    category: 'coding',
    sizes: ['0.5b', '1.5b', '3b', '7b', '14b', '32b'],
    pulls: '15M+',
    tags: ['coding'],
  },
  {
    name: 'mistral',
    description: 'Fast and efficient 7B model from Mistral AI',
    category: 'general',
    sizes: ['7b'],
    pulls: '40M+',
    tags: ['fast', 'general'],
  },
  {
    name: 'mixtral',
    description: 'Mixture of experts model with strong performance',
    category: 'general',
    sizes: ['8x7b', '8x22b'],
    pulls: '10M+',
    tags: ['moe', 'general'],
  },
  {
    name: 'codellama',
    description: "Meta's code-specialized Llama model for development",
    category: 'coding',
    sizes: ['7b', '13b', '34b', '70b'],
    pulls: '25M+',
    tags: ['coding'],
  },
  {
    name: 'phi3',
    description: "Microsoft's small but capable model",
    category: 'general',
    sizes: ['3.8b', '14b'],
    pulls: '15M+',
    tags: ['small', 'efficient'],
  },
  {
    name: 'llava',
    description: 'Vision-language model for image understanding',
    category: 'vision',
    sizes: ['7b', '13b', '34b'],
    pulls: '10M+',
    tags: ['vision', 'multimodal'],
  },
  {
    name: 'nomic-embed-text',
    description: 'High-quality text embedding model for RAG and search',
    category: 'embedding',
    sizes: ['137m'],
    pulls: '8M+',
    tags: ['embedding', 'rag'],
  },
  {
    name: 'mxbai-embed-large',
    description: 'Large embedding model with strong semantic understanding',
    category: 'embedding',
    sizes: ['335m'],
    pulls: '5M+',
    tags: ['embedding', 'rag'],
  },
  {
    name: 'starcoder2',
    description: 'Code generation model trained on diverse languages',
    category: 'coding',
    sizes: ['3b', '7b', '15b'],
    pulls: '3M+',
    tags: ['coding'],
  },
  {
    name: 'dolphin-mixtral',
    description: 'Uncensored Mixtral variant for unrestricted conversations',
    category: 'general',
    sizes: ['8x7b'],
    pulls: '2M+',
    tags: ['uncensored', 'moe'],
  },
];

const decodeHtmlEntities = (value: string): string =>
  value.replace(
    /&(#x[\da-f]+|#\d+|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, code: string) => {
      const normalized = code.toLowerCase();
      if (normalized.startsWith('#x')) {
        return String.fromCodePoint(parseInt(normalized.slice(2), 16));
      }
      if (normalized.startsWith('#')) {
        return String.fromCodePoint(parseInt(normalized.slice(1), 10));
      }
      return (
        {
          amp: '&',
          apos: "'",
          gt: '>',
          lt: '<',
          nbsp: ' ',
          quot: '"',
        }[normalized] || entity
      );
    }
  );

const htmlText = (value: string): string =>
  decodeHtmlEntities(value.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const parseModelBadges = (
  cardHtml: string
): { sizes: string[]; tags: string[] } => {
  const badgesHtml =
    cardHtml.match(
      /<div\b[^>]*class=["'][^"']*\bflex-wrap\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
    )?.[1] || '';
  const sizes: string[] = [];
  const tags: string[] = [];
  const badgePattern =
    /<span\b[^>]*class=["']([^"']*)["'][^>]*>([\s\S]*?)<\/span>/gi;
  let badgeMatch: RegExpExecArray | null;

  while ((badgeMatch = badgePattern.exec(badgesHtml)) !== null) {
    const label = htmlText(badgeMatch[2]).toLowerCase();
    if (!label) continue;

    if (
      MODEL_CAPABILITY_TAGS.has(label) ||
      !badgeMatch[1].includes('text-blue-600')
    ) {
      if (!tags.includes(label)) tags.push(label);
    } else if (!sizes.includes(label)) {
      sizes.push(label);
    }
  }

  return { sizes, tags };
};

const parsePullCount = (cardHtml: string): string | undefined => {
  const match = cardHtml.match(
    /<span\b[^>]*class=["'][^"']*\bflex items-center\b[^"']*["'][^>]*>[\s\S]*?<span\b[^>]*>([^<]+)<\/span>\s*<span\b[^>]*>[^<]*Pulls?<\/span>/i
  );
  return match ? htmlText(match[1]) : undefined;
};

export function parseOllamaSearchHtml(html: string): RemoteModelInfo[] {
  const models: RemoteModelInfo[] = [];
  const modelPattern =
    /<a\b[^>]*href=["']\/library\/([^"'?#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = modelPattern.exec(html)) !== null) {
    let name = match[1];
    try {
      name = decodeURIComponent(name);
    } catch {
      // Keep the safe URL path segment when it is not valid percent encoding.
    }
    if (models.some(model => model.name === name)) continue;

    const cardHtml = match[2];
    const descriptionMatch = cardHtml.match(
      /<p\b[^>]*class=["'][^"']*\btext-neutral-800\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i
    );
    const { sizes, tags } = parseModelBadges(cardHtml);
    const category = tags.includes('embedding')
      ? 'embedding'
      : tags.includes('vision')
        ? 'vision'
        : tags.includes('thinking')
          ? 'reasoning'
          : inferOllamaModelCategory(name);

    models.push({
      name,
      description: descriptionMatch ? htmlText(descriptionMatch[1]) : '',
      category,
      sizes,
      pulls: parsePullCount(cardHtml),
      tags: Array.from(new Set([category, ...tags])),
    });
  }

  return models;
}

function inferOllamaModelCategory(name: string): string {
  const nameLower = name.toLowerCase();
  if (
    nameLower.includes('coder') ||
    nameLower.includes('code') ||
    nameLower.includes('starcoder') ||
    nameLower.includes('devstral')
  ) {
    return 'coding';
  }
  if (nameLower.includes('embed') || nameLower.includes('embedding')) {
    return 'embedding';
  }
  if (
    nameLower.includes('vision') ||
    nameLower.includes('vl') ||
    nameLower.includes('llava')
  ) {
    return 'vision';
  }
  if (
    nameLower.includes('thinking') ||
    nameLower.includes('r1') ||
    nameLower.includes('reasoning')
  ) {
    return 'reasoning';
  }
  return 'general';
}

async function fetchOllamaPage(
  params: URLSearchParams,
  page: number,
  signal: AbortSignal
): Promise<RemoteModelInfo[]> {
  const pageParams = new URLSearchParams(params);
  if (page > 1) pageParams.set('page', String(page));

  const response = await fetch(
    `https://ollama.com/search?${pageParams.toString()}`,
    {
      signal,
      headers: {
        Accept: 'text/html',
        'HX-Request': 'true',
        'User-Agent':
          'Mozilla/5.0 (compatible; LibreWebUI/1.0; +https://librewebui.org)',
      },
    }
  );

  if (!response.ok) {
    return [];
  }

  return parseOllamaSearchHtml(await response.text());
}

function filterCuratedModels(search: string, category: string) {
  let models = [...CURATED_MODELS];
  if (search) {
    const searchLower = search.toLowerCase();
    models = models.filter(
      model =>
        model.name.toLowerCase().includes(searchLower) ||
        model.description.toLowerCase().includes(searchLower)
    );
  }

  if (category) {
    models = models.filter(model =>
      model.tags?.includes(category.toLowerCase())
    );
  }

  return models;
}

function normalizeCloudModels(models: RemoteModelInfo[]) {
  return models.map(model => ({
    ...model,
    name: model.name.includes(':') ? model.name : `${model.name}:cloud`,
    category: 'cloud',
    tags: Array.from(new Set([...(model.tags ?? []), 'cloud'])),
  }));
}

export async function getOllamaLibraryModels({
  search = '',
  sort = 'popular',
  category = '',
  pages = 15,
}: OllamaLibraryQuery): Promise<RemoteModelInfo[]> {
  let remoteModels: RemoteModelInfo[] = [];

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const params = new URLSearchParams();
    if (search) params.set('q', search);
    params.set('o', sort === 'newest' ? 'newest' : 'popular');
    if (category) params.set('c', category);

    const pageResults = await Promise.all(
      Array.from({ length: pages }, (_, i) =>
        fetchOllamaPage(params, i + 1, controller.signal).catch(() => [])
      )
    );
    clearTimeout(timeoutId);

    const seenNames = new Set<string>();
    for (const pageModels of pageResults) {
      for (const model of pageModels) {
        if (!seenNames.has(model.name)) {
          seenNames.add(model.name);
          remoteModels.push(model);
        }
      }
    }
  } catch (_fetchError) {
    remoteModels = [];
  }

  if (remoteModels.length === 0) {
    logger.warn(
      'The live Ollama catalogue returned no readable model cards; using the curated fallback.'
    );
    remoteModels = filterCuratedModels(search, category);
  } else {
    logger.debug(`Loaded ${remoteModels.length} models from ollama.com`);
  }

  return category === 'cloud'
    ? normalizeCloudModels(remoteModels)
    : remoteModels;
}
