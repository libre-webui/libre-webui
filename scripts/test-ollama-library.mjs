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
  getOllamaLibraryModels,
  parseOllamaSearchHtml,
} from '../backend/dist/utils/ollamaLibrary.js';

const currentOllamaCard = ({ name, description, badges, pulls }) => `
  <a href="/library/${name}" class="group w-full">
    <div class="flex flex-col mb-1" title="${name}">
      <h2><span>${name}</span></h2>
      <p class="max-w-lg break-words text-neutral-800 text-md">${description}</p>
    </div>
    <div class="flex flex-col">
      <div class="flex flex-wrap space-x-2">
        ${badges
          .map(
            ({ label, size = false }) =>
              `<span class="inline-flex rounded-md ${
                size ? 'text-blue-600' : 'text-indigo-600'
              }">${label}</span>`
          )
          .join('')}
      </div>
      <p>
        <span class="flex items-center">
          <svg></svg>
          <span>${pulls}</span>
          <span class="hidden sm:flex">&nbsp;Pulls</span>
        </span>
      </p>
    </div>
  </a>
`;

test('parses the current ollama.com catalogue card markup', () => {
  const html = [
    currentOllamaCard({
      name: 'qwen3.5',
      description: 'Fast &amp; capable.',
      badges: [
        { label: 'vision' },
        { label: 'tools' },
        { label: 'thinking' },
        { label: 'cloud' },
        { label: '0.8b', size: true },
        { label: '27b', size: true },
      ],
      pulls: '16.5M',
    }),
    currentOllamaCard({
      name: 'nomic-embed-text',
      description: 'Embedding model.',
      badges: [{ label: 'embedding' }, { label: '137m', size: true }],
      pulls: '80.2M',
    }),
    currentOllamaCard({
      name: 'glm-5.2',
      description: 'Thinking model.',
      badges: [{ label: 'thinking' }, { label: 'cloud' }],
      pulls: '2.4M',
    }),
  ].join('');

  assert.deepEqual(parseOllamaSearchHtml(html), [
    {
      name: 'qwen3.5',
      description: 'Fast & capable.',
      category: 'vision',
      sizes: ['0.8b', '27b'],
      pulls: '16.5M',
      tags: ['vision', 'tools', 'thinking', 'cloud'],
    },
    {
      name: 'nomic-embed-text',
      description: 'Embedding model.',
      category: 'embedding',
      sizes: ['137m'],
      pulls: '80.2M',
      tags: ['embedding'],
    },
    {
      name: 'glm-5.2',
      description: 'Thinking model.',
      category: 'reasoning',
      sizes: [],
      pulls: '2.4M',
      tags: ['reasoning', 'thinking', 'cloud'],
    },
  ]);
});

test('deduplicates repeated model cards across catalogue pages', () => {
  const card = currentOllamaCard({
    name: 'llama3.2',
    description: 'Small model.',
    badges: [{ label: '3b', size: true }],
    pulls: '78.3M',
  });

  assert.equal(parseOllamaSearchHtml(`${card}${card}`).length, 1);
});

test('requests and aggregates each configured catalogue page', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls = [];
  const sharedCard = currentOllamaCard({
    name: 'shared-model',
    description: 'Appears on both pages.',
    badges: [{ label: '7b', size: true }],
    pulls: '10M',
  });

  globalThis.fetch = async input => {
    const url = new URL(String(input));
    requestedUrls.push(url);
    const page = url.searchParams.get('page') ?? '1';
    const uniqueCard = currentOllamaCard({
      name: `page-${page}-model`,
      description: `Unique page ${page} model.`,
      badges: [{ label: 'thinking' }],
      pulls: `${page}M`,
    });
    return new Response(`${sharedCard}${uniqueCard}`, { status: 200 });
  };

  try {
    const models = await getOllamaLibraryModels({
      search: 'glm',
      sort: 'newest',
      pages: 2,
    });

    assert.deepEqual(
      models.map(model => model.name),
      ['shared-model', 'page-1-model', 'page-2-model']
    );
    assert.deepEqual(
      requestedUrls.map(url => url.searchParams.get('page') ?? '1'),
      ['1', '2']
    );
    for (const url of requestedUrls) {
      assert.equal(url.origin, 'https://ollama.com');
      assert.equal(url.pathname, '/search');
      assert.equal(url.searchParams.get('q'), 'glm');
      assert.equal(url.searchParams.get('o'), 'newest');
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
